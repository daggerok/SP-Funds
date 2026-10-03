#!/usr/bin/env bun
/// <reference types="bun" />

// SP Funds (Sharia-Compliant ETFs) static feed. Bun-only, zero runtime dependencies.
// Console/reporting shape, config-file precedence and the N-PORT/Python-free helpers follow
// the shared family conventions; the holdings-CSV contract matches the other TidalFG-hosted brands.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

export type JsonRecord = Record<string, unknown>;
export type SheetRow = Record<string, string>;
export type Sheet = { headers: string[]; rows: SheetRow[]; asOfDate: string | null };

export type OfficialReturnRow = {
  asOfDate: string | null;
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};
export type NumericReturnKey = Exclude<keyof OfficialReturnRow, 'asOfDate'>;
export const emptyReturns = (): OfficialReturnRow => ({
  asOfDate: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null,
});

export type CatalogFund = {
  ticker: string;
  name: string | null;
  category: string | null;
  fundPage: string;
  inceptionDate: string | null;
  terValue: number | null;
  netTerValue: number | null;
  aumValue: number | null;
  officialReturns: OfficialReturnRow;
};

export type FundDetails = CatalogFund & {
  cusip: string | null;
  isin: string | null;
  indexTicker: string | null;
  exchange: string | null;
  navValue: number | null;
  navAsOfDate: string | null;
  secYield: number | null;
  distributionRate: number | null;
  frequency: string | null;
  midpoint: number | null;
  premiumDiscount: number | null;
  /** Gross expense ratio when the page publishes one; `terValue` is the net (or only) figure. */
  terGrossValue?: number | null;
  closePriceValue?: number | null;
};

export type Dividend = {
  epoch: number;
  amount: number;
  exDate: string;
  recordDate: string | null;
  payDate: string | null;
};

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
export type ParsedChart = {
  days: ChartDay[];
  dividends: Dividend[];
  exchange: string | null;
  firstTradeDate: string | null;
  longName: string | null;
};

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
export const HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'];

export const SPFUNDS_SITE = 'https://www.sp-funds.com';
export const SPFUNDS_LINEUP_URL = `${SPFUNDS_SITE}/`;
export const holdingsCsvUrl = (ticker: string): string =>
  `${SPFUNDS_SITE}/wp-content/uploads/data/TidalFG_Holdings_${sanitizeTicker(ticker)}.csv`;
export const holdingsCsvProvenanceUrl = (ticker: string): string =>
  `${SPFUNDS_SITE}/wp-content/uploads/data/TidalFG_Holdings_${sanitizeTicker(ticker)}.csv`;
export const fundPageUrl = (ticker: string): string => `${SPFUNDS_SITE}/${sanitizeTicker(ticker).toLowerCase()}/`;
/**
 * Explicit period1/period2 (a `range=` parameter is ignored next to them): `max` starts at
 * the epoch, `<N>y` starts N years before now, so HISTORY_RANGE really limits the window.
 */
export const yahooChartUrl = (ticker: string, range: string = 'max', nowMs: number = Date.now()): string => {
  // +1 day: Yahoo excludes the final bar when period2 is exactly now.
  const nowSec = Math.floor(nowMs / 1000);
  const period2 = nowSec + 86_400;
  const years = /^(\d+)y$/i.exec(range.trim());
  const period1 = years ? Math.max(0, Math.floor(nowSec - Number(years[1]) * 365.25 * 86_400)) : 0;
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sanitizeTicker(ticker))}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
};
export const yahooChartProvenanceUrl = (ticker: string): string =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sanitizeTicker(ticker))}`;

// Two registrants file the SP Funds ETFs' Form N-PORT-P filings.
export const TIDAL_TRUST = { name: 'Tidal Trust I', cik: '0001742912', formerName: 'Tidal ETF Trust', fileNumber: '811-23472' };
export const SPFUNDS_TRUST = { name: 'SP Funds Trust', cik: '0001989916', fileNumber: '811-23770' };
export const SPFUNDS_TICKERS = ['SPUS', 'SPRE', 'SPSK', 'SPTE', 'SPWO'] as const;
export const trustForTicker = (ticker: string): { name: string; cik: string } =>
  ['SPTE', 'SPWO'].includes(sanitizeTicker(ticker)) ? SPFUNDS_TRUST : TIDAL_TRUST;

const SEC_DATA_HOST = 'https://data.sec.gov';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
export const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function decodeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Strip markup/entities and normalise whitespace. */
export function cleanText(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw === 'object') return '';
  return decodeXml(String(raw).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function sanitizeTicker(raw: unknown): string {
  return cleanText(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function numberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let text = cleanText(raw).replace(/[$,%\s]/g, '').replace(/\u2212/g, '-');
  if (!text || /^(?:-|—|–|N\/?A|--|null|nan)$/i.test(text)) return null;
  if (/^\(.+\)$/.test(text)) text = '-' + text.slice(1, -1);
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Prices on the fund pages are published with a magnitude suffix ("$3274.89m",
 * "$3.28B"); numberOrNull would drop them, so money parsing understands K/M/B/T.
 */
export function parseMoneyNumber(raw: unknown): number | null {
  const text = cleanText(raw).replace(/[$,\s]/g, '');
  if (!text) return null;
  const match = /^([+-]?[\d.]+)\s*([KMBT])?$/i.exec(text);
  if (!match) return numberOrNull(raw);
  const suffix = match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] ?? 1 : 1;
  const value = Number(match[1]) * suffix;
  return Number.isFinite(value) ? value : null;
}

export function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

/** `10/01/2026`, `2026-10-01`, `Oct 1 2026` -> `2026-10-01`; null when unparseable. */
export function toIsoDate(raw: unknown): string | null {
  const text = cleanText(raw);
  if (!text || /^(?:—|–|--|N\/?A)$/i.test(text)) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const ms = Date.parse(text + ' UTC');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** `10/01/2026` -> `Oct 1 2026` (the display format the shared feed publishes). */
export function formatUsDate(raw: unknown): string | null {
  const iso = toIsoDate(raw);
  if (!iso) return null;
  const [year, month, day] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(month) - 1]} ${Number(day)} ${year}`;
}

/** `Sep 30 2026` (zero-padded day, UTC) from an ISO date; the date text the sibling feeds publish. */
export function formatSheetDate(raw: unknown): string {
  const iso = toIsoDate(raw);
  if (!iso) return cleanText(raw);
  const [year, month, day] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(month) - 1]} ${day} ${year}`;
}

/** ISO timestamp without milliseconds (`2026-10-01T12:00:00Z`). */
export function isoStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** True when a fund incepted on `inception` has existed for `years` full years on `asOf` (both ISO dates). */
export function tenorAvailable(inception: string | null, asOf: string | null, years: number): boolean {
  if (!inception || !asOf) return true; // unknown age: keep what the provider printed
  const start = new Date(`${inception}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return true;
  start.setUTCFullYear(start.getUTCFullYear() + years);
  return start.toISOString().slice(0, 10) <= asOf;
}

export function epochToIsoDate(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export function formatAumDisplay(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatMoneyText(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatPercentText(value: number | null, digits = 2): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

/** Weight as a plain percent number text, the provider's own precision: `14.14%` -> `14.14`. */
export function normalizeWeightText(raw: unknown): string {
  const text = cleanText(raw);
  if (!text || text === '—') return '';
  const value = numberOrNull(text);
  if (value === null) return text;
  return String(value);
}

/** Plain numeric text of a money cell (`$30956597.21` -> `30956597.21`), empty when there is none. */
export function normalizeMoneyCell(raw: unknown): string {
  const value = numberOrNull(raw);
  return value === null ? '' : String(value);
}

/** Holdings rows in the plain-numeric sibling shape (also converts rows published by older runs). */
export function normalizeHoldingsRow(row: SheetRow): SheetRow {
  return { ...row, Weight: normalizeWeightText(row['Weight']), 'Market Value': normalizeMoneyCell(row['Market Value']) };
}

// ---------------------------------------------------------------------------
// Configuration: checked-in JSON defaults, nonblank ENV always wins
// ---------------------------------------------------------------------------

type Range = { min: number; max: number };
export type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

export type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  edgarFallback: boolean;
  skipSpFunds: boolean;
  skipYahoo: boolean;
  secUa: string;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

export const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;
export const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

// File defaults and explicit overrides, resolved identically by the CLI and the workflow.
// Precedence: config file < advanced JSON < nonblank named inputs < environment (an explicitly
// set environment variable wins even when empty) < protected Actions variables (workflow only,
// passed as the environment layer). Allowlisted scalar controls only, strictly validated.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'TICKERS', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'HISTORY_RANGE',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
  'SEC_UA', 'SKIP_SPFUNDS', 'SKIP_YAHOO', 'EDGAR_FALLBACK', 'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
/** Environment aliases accepted next to the canonical control name. */
const CONTROL_ALIASES: Partial<Record<ControlName, string[]>> = { SKIP_SPFUNDS: ['SKIP_SP_FUNDS'] };

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = [key, ...(CONTROL_ALIASES[key] ?? [])].map((name) => env[name]).find((candidate) => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  readConfig(result); // validate every control before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try {
    file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return resolveControls(file, {}, {}, env);
}

function parseInteger(controls: Record<string, string | undefined>, name: string, min: number, fallback: number): number {
  const raw = (controls[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min) throw new Error(`${name}: expected integer >= ${min}`);
  return Number(raw);
}

function parseFlag(controls: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = (controls[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/^(1|true|yes|y|on)$/.test(raw)) return true;
  if (/^(0|false|no|n|off)$/.test(raw)) return false;
  throw new Error(`${name}: expected boolean`);
}

/** USE_SYSTEM_CA: auto (default, also when blank) | true | false, case-insensitive. */
export function parseSystemCaMode(controls: Record<string, string | undefined>): 'auto' | 'true' | 'false' {
  const raw = (controls['USE_SYSTEM_CA'] ?? '').trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || raw === 'true' || raw === 'false') return raw;
  throw new Error('USE_SYSTEM_CA: expected auto, true or false');
}

function parseBound(name: string, text: string, aum: boolean): number | undefined {
  const bound = text.trim().toLowerCase();
  if (!bound) return undefined;
  if (aum && bound in AUM_PRESET_BOUNDS) return AUM_PRESET_BOUNDS[bound as AumPreset].min;
  const match = (aum ? /^(\d+(?:\.\d+)?|\.\d+)\s*([kmbt])?$/ : /^(-?(?:\d+(?:\.\d+)?|\.\d+))$/).exec(bound);
  if (!match) throw new Error(`${name}: invalid bound "${text.trim()}"`);
  const value = Number(match[1]) * (match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] ?? 1 : 1);
  if (!Number.isFinite(value)) throw new Error(`${name}: invalid bound "${text.trim()}"`);
  return value;
}

function parseRangeStrict(name: string, raw: string, aum: boolean): (Range & { source?: string }) | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  if (aum && text.toLowerCase() in AUM_PRESET_BOUNDS) {
    const preset = AUM_PRESET_BOUNDS[text.toLowerCase() as AumPreset];
    return { min: preset.min, max: preset.max ?? Number.POSITIVE_INFINITY, source: text.toLowerCase() };
  }
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`${name}: expected min:max`);
  const min = parseBound(name, parts[0], aum) ?? (aum ? 0 : Number.NEGATIVE_INFINITY);
  const max = parseBound(name, parts[1], aum) ?? Number.POSITIVE_INFINITY;
  if (min > max) throw new Error(`${name}: min must not exceed max`);
  return aum ? { min, max, source: text } : { min, max };
}

export const parseAumRange = (raw: string): (Range & { source?: string }) | undefined => parseRangeStrict('AUM', raw, true);
export const parseRange = (raw: string, name = 'range'): Range | undefined => parseRangeStrict(name, raw, false);

function parseRanges(controls: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const range = parseRange(controls[`${prefix}_${period}`] ?? '', `${prefix}_${period}`);
    if (range) ranges[period] = range;
  }
  return ranges;
}

/** Turns resolved (string) controls into the typed config; every invalid value is an error, never a fallback. */
export function readConfig(controls: Record<string, string | undefined> = {}): UpdaterConfig {
  const requestSleepRaw = (controls['REQUEST_SLEEP'] ?? '').trim();
  if (requestSleepRaw && (!/^\d+(?:\.\d+)?$/.test(requestSleepRaw) || !Number.isFinite(Number(requestSleepRaw)))) {
    throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  }
  const historyRange = (controls['HISTORY_RANGE'] ?? '').trim().toLowerCase() || 'max';
  if (!/^(max|\d+y)$/.test(historyRange)) throw new Error('HISTORY_RANGE: expected max or <N>y');
  if (/^0+y$/.test(historyRange)) throw new Error('HISTORY_RANGE: expected max or <N>y with N >= 1');
  parseFlag(controls, 'VERBOSE', false); // validated here; applied through process.env in main()
  parseSystemCaMode(controls);
  const tickersRaw = controls['TICKERS'] ?? '';
  return {
    concurrency: parseInteger(controls, 'CONCURRENCY', 1, 2),
    requestSleep: requestSleepRaw ? Number(requestSleepRaw) : 1,
    maxFetches: parseInteger(controls, 'MAX_FETCHES', 0, 0),
    holdingsPageSize: parseInteger(controls, 'HOLDINGS_PAGE_SIZE', 1, 250),
    historyPageSize: parseInteger(controls, 'HISTORY_PAGE_SIZE', 1, 1000),
    maxRetries: parseInteger(controls, 'MAX_RETRIES', 1, 2),
    tickers: tickersRaw.split(/[\s,;]+/).map(sanitizeTicker).filter(Boolean),
    historyRange,
    edgarFallback: parseFlag(controls, 'EDGAR_FALLBACK', true),
    skipSpFunds: parseFlag(controls, 'SKIP_SPFUNDS', false),
    skipYahoo: parseFlag(controls, 'SKIP_YAHOO', false),
    // EDGAR requires a declared identity with a reachable contact ("Company Name email").
    secUa: (controls['SEC_UA'] ?? '').trim() || SEC_UA_DEFAULT,
    aumRange: parseAumRange(controls['AUM'] ?? ''),
    terRange: parseRange(controls['TER'] ?? '', 'TER'),
    dividendYieldRange: parseRange(controls['DIVIDEND_YIELD'] ?? '', 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(controls['SEC_YIELD'] ?? '', 'SEC_YIELD'),
    performanceRanges: parseRanges(controls, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(controls, 'TOTAL_RETURN'),
  };
}

export const USAGE = `
SP Funds static feed updater (Bun, zero runtime dependencies).

Usage:
  ./scripts/update-data.ts [--help]        (or: bun ./scripts/update-data.ts)

Controls come from scripts/update-data.config.json (flat JSON of strings). An explicitly
set environment variable wins over the file, even when empty. The workflow resolves the
same way: file < advanced JSON < nonblank inputs < protected Actions variable.
Invalid values are errors, never silent fallbacks.

Controls:

  MAX_FETCHES        0 = process every selected fund; N > 0 = at most N funds per run,
                     resuming after the ticker cursor in api/spfunds/update-state.json
  REQUEST_SLEEP      Seconds between request starts inside one worker lane (default 1)
  CONCURRENCY        Independent worker lanes / parallel funds, integer >= 1 (default 2)
  TICKERS            Space/comma/semicolon separated subset of the catalog, e.g. "SPUS SPSK SPWO"
  AUM                AUM min:max (K/M/B/T suffixes or nano/micro/small/mid/large)
  TER                Expense-ratio percentage range: min:max
  DIVIDEND_YIELD     Derived distribution-rate percentage range: min:max
  SEC_YIELD          Official 30-day SEC yield percentage range: min:max
                     (range filters are evaluated per fund against freshly parsed facts)
  HOLDINGS_PAGE_SIZE Rows per generated holdings JSON page (default 250)
  HISTORY_PAGE_SIZE  Rows per generated history JSON page (default 1000)
  MAX_RETRIES        Retries after the initial request for 408/425/429/5xx, integer >= 1 (default 2)
  HISTORY_RANGE      Yahoo history window: max or <N>y, e.g. 5y (default max)
  PERFORMANCE_<P>    Official month-end NAV return range for P in YTD,1Y,3Y,5Y,10Y
  TOTAL_RETURN_<P>   Derived cumulative total-return range for the same periods
  SEC_UA             Declared SEC contact string (EDGAR requires an identity; redacted in logs)
  SKIP_SPFUNDS       true = keep the previously published issuer data (catalog/meta/holdings)
  SKIP_YAHOO         true = keep the previously published Yahoo history/distributions
  EDGAR_FALLBACK     true = use SEC N-PORT-P holdings when the issuer CSV is unavailable
  VERBOSE            true = print per-request retry/fallback notices
  USE_SYSTEM_CA      auto (default) = restart once with Bun --use-system-ca on an untrusted-certificate error; true = always; false = never
`;

// ---------------------------------------------------------------------------
// Official HTML: catalog cards, fund-page tables, documents
// ---------------------------------------------------------------------------

/** Split a fragment into its `<tr>` bodies (nested tables are not used by this site). */
export function tableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const row of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(cleanText(cell[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

export type HtmlTable = { start: number; id: string; headers: string[]; rows: string[][] };

/** Every `<table>` with its absolute offset, so callers can scope tables to a section. */
export function parseHtmlTables(html: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const idMatch = /\bid=["']([^"']+)["']/.exec(match[1]);
    const rows = tableRows(match[2]);
    tables.push({ start: match.index, id: idMatch ? idMatch[1] : '', headers: rows[0] ?? [], rows: rows.slice(1) });
  }
  return tables;
}

/** Convert a two-column `Name | Value` table into a lookup map. */
export function nameValueMap(rows: string[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = cleanText(row[0]);
    if (!name) continue;
    if (!map.has(name)) map.set(name, cleanText(row[1] ?? ''));
  }
  return map;
}

/** The first map entry whose key matches the pattern (the site appends `*`/as-of text to labels). */
export function lookupPattern(map: Map<string, string>, pattern: RegExp): string | null {
  for (const [key, value] of map) if (pattern.test(key)) return value;
  return null;
}

export type CatalogCard = { ticker: string; name: string | null; description: string | null; fundPage: string };

/** Homepage "Sharia-compliant, Values-Driven ETFs" cards (ticker + blurb + link). */
export function parseCatalogCards(html: string): CatalogCard[] {
  const cards: CatalogCard[] = [];
  const blockRe = /<div\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-content[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-content|$)/gi;
  for (const block of html.matchAll(blockRe)) {
    const body = block[1];
    const tickerMatch = /<h3\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(body);
    const ticker = sanitizeTicker(tickerMatch ? cleanText(tickerMatch[1]) : '');
    if (!ticker || !/^[A-Z]{4,5}$/.test(ticker)) continue;
    const descriptionMatch = /<div\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body);
    const linkMatch = /<a\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-readmore[^"]*"[^>]*href="([^"]+)"/i.exec(body);
    const href = linkMatch ? cleanText(linkMatch[1]) : '';
    const fundPage = /^https?:\/\//.test(href)
      ? (href.startsWith(SPFUNDS_SITE) ? href : null)
      : (/^\/[a-z0-9-]+\/?$/.test(href) ? `${SPFUNDS_SITE}${href}` : null);
    if (!fundPage) continue;
    cards.push({
      ticker,
      name: null,
      description: descriptionMatch ? cleanText(descriptionMatch[1]) : null,
      fundPage,
    });
  }
  return cards;
}

/**
 * The header "Our ETFs" sub-menu is the authoritative, structurally separate fund
 * lineup: the sibling menu ("Target Date Funds") holds the mutual funds, so the
 * parser never has to guess by ticker length. Note that a homepage card can point
 * at a section page (SPRE -> /spre-2/), so the menu link wins.
 */
export function parseCatalogMenu(html: string): CatalogCard[] {
  const menu = /<li\b[^>]*>\s*<a\b[^>]*>\s*<span[^>]*>\s*Our ETFs\s*<\/span>\s*<\/a>\s*<ul\b[^>]*class="[^"]*sub-menu[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(html);
  const body = menu ? menu[1] : '';
  if (!body) return [];
  const entries: CatalogCard[] = [];
  for (const item of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = cleanText(item[1]);
    const href = /^https?:\/\//.test(raw) ? raw : (/^\/[a-z0-9-]+\/?$/.test(raw) ? `${SPFUNDS_SITE}${raw}` : '');
    // Section pages (for example /spre-2/) still resolve to the fund page once the
    // menu link for the ticker is known, so cards only fill the gap.
    const ticker = sanitizeTicker(item[2]);
    if (!/^[A-Z]{4,5}$/.test(ticker) || !href) continue;
    if (entries.some((entry) => entry.ticker === ticker)) continue;
    entries.push({ ticker, name: null, description: null, fundPage: href });
  }
  return entries;
}

export function buildCatalog(html: string, tickers: string[]): CatalogFund[] {
  const menu = parseCatalogMenu(html);
  const cards = parseCatalogCards(html);
  const byTicker = new Map<string, CatalogFund>();
  const wanted = tickers.length ? new Set(tickers.map(sanitizeTicker)) : null;
  const add = (entry: CatalogCard, name: string | null): void => {
    if (wanted && !wanted.has(entry.ticker)) return;
    if (byTicker.has(entry.ticker)) return;
    byTicker.set(entry.ticker, {
      ticker: entry.ticker,
      name,
      category: null,
      fundPage: entry.fundPage,
      inceptionDate: null,
      terValue: null,
      netTerValue: null,
      aumValue: null,
      officialReturns: emptyReturns(),
    });
  };
  for (const entry of menu.length ? menu : cards) {
    const card = cards.find((candidate) => candidate.ticker === entry.ticker);
    add({ ...entry, description: card?.description ?? entry.description }, card?.name ?? null);
  }
  // An explicit TICKERS selection still pulls in funds the site did not advertise.
  for (const ticker of tickers.map(sanitizeTicker).filter(Boolean)) {
    add({ ticker, name: null, description: null, fundPage: fundPageUrl(ticker) }, null);
  }
  if (!byTicker.size && !tickers.length) {
    // The site layout changed under us: keep the last known SP Funds lineup
    // instead of failing the whole run on a markup change.
    outputNote('[ catalog  ] fund lineup not found on the homepage; using the known SP Funds ETFs');
    for (const fund of FALLBACK_CATALOG) byTicker.set(fund.ticker, fund);
  }
  return [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export type FundPage = {
  ticker: string;
  name: string | null;
  details: Map<string, string>;
  pricing: Map<string, string>;
  pricingAsOf: string | null;
  holdingsAsOf: string | null;
  monthEnd: { tickerRow: string; returns: OfficialReturnRow } | null;
  quarterEnd: { tickerRow: string; returns: OfficialReturnRow } | null;
  benchmark: string | null;
  benchmarkName: string | null;
  distributions: { exDate: string; recordDate: string | null; payDate: string | null; amount: number | null }[];
  documents: Record<string, string | null>;
  holdingsCsvUrl: string | null;
  premiumDiscountUrl: string | null;
  performanceRows: Array<{ label: string; values: string[] }>;
};

/**
 * Official fund page. Every table is selected by its own header row rather than
 * by a table id: the ids differ per fund, the headers do not.
 */
export function parseFundPage(html: string, expectedTicker: string): FundPage {
  const ticker = sanitizeTicker(expectedTicker);
  const tables = parseHtmlTables(html);
  const byHeaders = (...names: string[]): HtmlTable[] =>
    tables.filter((table) => names.every((name) => table.headers.some((header) => header.toLowerCase() === name.toLowerCase())));

  const pairTables = byHeaders('Name', 'Value');
  const details = pairTables.length ? nameValueMap(pairTables[0].rows) : new Map<string, string>();
  const pricing = pairTables.length > 1 ? nameValueMap(pairTables[1].rows) : new Map<string, string>();

  const singleColumn = tables.filter((table) => table.headers.length === 1 && table.headers[0].toLowerCase() === 'name');
  const pricingAsOf = singleColumn.length ? toIsoDate(singleColumn[0].rows[0]?.[0]) : null;
  const holdingsAsOf = singleColumn.length > 1 ? toIsoDate(singleColumn[singleColumn.length - 1].rows[0]?.[0]) : null;

  const performance = byHeaders('Fund Name', 'Fund Ticker');
  const inception = toIsoDate(lookupPattern(details, /fund inception/i) ?? '');
  const readReturns = (table: HtmlTable | undefined): { tickerRow: string; fundName: string | null; returns: OfficialReturnRow } | null => {
    if (!table) return null;
    const indexOf = (header: string): number => table.headers.findIndex((value) => value.toLowerCase() === header.toLowerCase());
    const slotToKey: Record<string, NumericReturnKey> = {
      ytd: 'ytd', '1 year': 'yr1', '3 year': 'yr3', '5 year': 'yr5', '10 year': 'yr10',
    };
    const pickRow = (wanted: RegExp): string[] | null => table.rows.find((row) => wanted.test(cleanText(row[1] ?? ''))) ?? null;
    const row = pickRow(new RegExp(`^${ticker}\\s+NAV$`, 'i')) ?? pickRow(new RegExp(`^${ticker}\\s+MKT$`, 'i')) ?? pickRow(new RegExp(`^${ticker}\\b`, 'i'));
    if (!row) return null;
    const returns = emptyReturns();
    const asOf = row[indexOf('Date')] ?? '';
    returns.asOfDate = toIsoDate(asOf);
    // A tenor longer than the fund's age at the table date is not published as a number:
    // the site prints 0.00% for it, which must never become a real zero return.
    const tenorYears: Partial<Record<NumericReturnKey, number>> = { yr1: 1, yr3: 3, yr5: 5, yr10: 10 };
    for (const [header, key] of Object.entries(slotToKey)) {
      const value = numberOrNull(row[indexOf(header)]);
      const years = tenorYears[key];
      if (value !== null && (years === undefined || tenorAvailable(inception, returns.asOfDate, years))) returns[key] = value;
    }
    const annualized = numberOrNull(row[indexOf('Since Inception (Annualized)')]);
    if (annualized !== null && tenorAvailable(inception, returns.asOfDate, 1)) returns.sinceInception = annualized;
    const tickerRow = cleanText(row[1] ?? '');
    const fundName = cleanText(row[0] ?? '') || null;
    return { tickerRow, fundName, returns };
  };
  const monthEnd = readReturns(performance[0]);
  const quarterEnd = readReturns(performance[1] ?? performance[0]);
  const performanceRows = (performance[0]?.rows ?? []).map((row) => ({ label: cleanText(row[1] ?? ''), values: row }));

  // The benchmark rows are whichever rows are not the fund's own MKT/NAV lines:
  // the first one is the fund's declared index, later ones are extra comparisons.
  let benchmark: string | null = null;
  let benchmarkName: string | null = null;
  for (const row of performance[0]?.rows ?? []) {
    const label = cleanText(row[1] ?? '');
    if (!label || new RegExp(`^${ticker}\\b`, 'i').test(label)) continue;
    benchmark = label;
    benchmarkName = cleanText(row[0] ?? '') || null;
    break;
  }

  const distributionTable = byHeaders('EX Date', 'Record Date', 'Payable Date');
  const distributions = (distributionTable[0]?.rows ?? [])
    .map((row) => ({
      exDate: toIsoDate(row[0]) ?? '',
      recordDate: toIsoDate(row[1]),
      payDate: toIsoDate(row[2]),
      amount: numberOrNull(row[3]),
    }))
    .filter((row) => row.exDate);

  const documents: Record<string, string | null> = {};
  // Document tiles carry the PDF in a data-ep-wrapper-link JSON attribute; the
  // visible label is the h3 that follows it inside the same tile.
  for (const match of html.matchAll(/data-ep-wrapper-link="([^"]+)"/gi)) {
    const raw = decodeXml(match[1]).replace(/&quot;/g, '"');
    const urlMatch = /"url":"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (!urlMatch) continue;
    const url = urlMatch[1].replace(/\\\//g, '/');
    const tail = html.slice(match.index, match.index + 6000);
    const labelMatch = /<h3\b[^>]*class="[^"]*bdt-ep-advanced-icon-box-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(tail);
    const label = labelMatch ? cleanText(labelMatch[1]) : '';
    if (!label || !url) continue;
    const key = labelKey(label);
    if (key && !documents[key]) documents[key] = url;
  }

  const holdingsLink = /href="([^"]*TidalFG_Holdings_[^"]*\.csv)"/i.exec(html);
  const premiumLink = /href="([^"]*premium-discount[^"]*)"/i.exec(html);
  // The fund page H1 is the ticker; the official legal name is the first column
  // of the performance tables (fallback: the longest heading mentioning the ticker).
  let name = monthEnd?.fundName ?? null;
  if (!name) {
    for (const heading of html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)) {
      const text = cleanText(heading[1]);
      if (text && text.toUpperCase() !== ticker && text.length > ticker.length) { name = text; break; }
    }
  }

  return {
    ticker,
    name,
    details,
    pricing,
    pricingAsOf,
    holdingsAsOf,
    monthEnd,
    quarterEnd,
    distributions,
    benchmark,
    benchmarkName,
    documents,
    holdingsCsvUrl: holdingsLink ? holdingsLink[1] : null,
    premiumDiscountUrl: premiumLink ? premiumLink[1] : null,
    performanceRows,
  };
}

/** Map a document tile label to the shared documents contract, mirroring the sibling keys. */
export function labelKey(label: string): string | null {
  const text = cleanText(label).toLowerCase();
  if (!text) return null;
  if (/^prospectus/.test(text)) return 'prospectus';
  if (/summary prospectus/.test(text)) return 'summaryProspectus';
  if (/^sai$/.test(text) || /statement of additional information/.test(text)) return 'sai';
  if (/^factsheet/.test(text)) return 'factsheet';
  if (/^annual report/.test(text) || /annual financial statements/.test(text)) return 'annualReport';
  if (/semi[- ]?annual financial/.test(text) || /^semi[- ]?annual report/.test(text)) return 'semiAnnualReport';
  if (/investment case/.test(text)) return 'investmentCase';
  if (/esg/.test(text)) return 'esgWhitepaper';
  if (/fiscal q1/.test(text)) return 'fiscalQ1Holdings';
  if (/fiscal q3/.test(text)) return 'fiscalQ3Holdings';
  if (/form 8937/.test(text)) return 'form8937';
  if (/certificate of sharia/.test(text)) return 'certificateOfShariaAccreditation';
  if (/sharia auditor/.test(text)) return 'shariaAuditorReport';
  if (/annual tsr/.test(text)) return 'annualTsr';
  if (/semi[- ]?annual tsr/.test(text)) return 'semiAnnualTsr';
  if (/proxy/.test(text)) return 'proxyVotes';
  return null;
}

// ---------------------------------------------------------------------------
// Official daily holdings CSV (TidalFG format)
// ---------------------------------------------------------------------------

/** RFC-4180-ish reader that tolerates a UTF-8 BOM, CRLF and quoted fields with commas. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export const SPFUNDS_HOLDINGS_CSV_HEADERS = [
  'Date', 'Account', 'StockTicker', 'CUSIP', 'SecurityName', 'Shares',
  'Price', 'MarketValue', 'Weightings', 'NetAssets', 'SharesOutstanding', 'CreationUnits',
] as const;

/** `SPXW  261001P07075000` — an OCC option symbol (root, padded date, C/P, strike). */
const OCC_OPTION = /^[A-Z0-9]{1,6}\s+\d{6}[CP]\d{8}$/;

/**
 * The CSV publishes no asset-class column, so the Watchlist's category is derived
 * from the row's own identifying fields (documented as derived in the README). Cash balances and currency lines are Cash, exchange-traded
 * fund/trust units are Fund, option contracts are Option, everything else Equity.
 */
export function spFundsAssetCategory(stockTicker: string, securityName: string): string {
  const ticker = cleanText(stockTicker);
  const name = cleanText(securityName);
  if (/^cash\s*&\s*other$/i.test(ticker) || /^cash/i.test(ticker)) return 'Cash';
  if (OCC_OPTION.test(ticker)) return 'Option';
  if (/^cash\s*&\s*other$/i.test(name)) return 'Cash';
  if (/treasury|t-bill|t bill|sukuk/i.test(name)) return 'Fixed Income';
  if (/\betf\b|exchange[- ]traded|\breit\b|\bfund\b|\btrust\b/i.test(name)) return 'Fund';
  return 'Equity';
}

export type ParsedHoldings = {
  headers: string[];
  rows: SheetRow[];
  asOfDate: string | null;
  netAssets: number | null;
  sharesOutstanding: number | null;
  creationUnits: number | null;
  totalRows: number;
};

/**
 * Map the official daily CSV onto the shared holdings contract. The provider's
 * own Weightings/MarketValue/Shares strings are preserved (including the negative
 * currency and cash lines), exactly like the sibling CSV parser.
 */
export function parseSpFundsHoldingsCsv(text: string): ParsedHoldings {
  const table = parseCsv(text);
  if (!table.length) {
    return { headers: [...HOLDINGS_HEADERS], rows: [], asOfDate: null, netAssets: null, sharesOutstanding: null, creationUnits: null, totalRows: 0 };
  }
  const header = table[0].map((cell) => cleanText(cell));
  const indexOf = (name: string): number => header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase());
  const at = {
    date: indexOf('Date'),
    ticker: indexOf('StockTicker'),
    cusip: indexOf('CUSIP'),
    name: indexOf('SecurityName'),
    shares: indexOf('Shares'),
    marketValue: indexOf('MarketValue'),
    weight: indexOf('Weightings'),
    netAssets: indexOf('NetAssets'),
    sharesOutstanding: indexOf('SharesOutstanding'),
    creationUnits: indexOf('CreationUnits'),
  };
  if (at.ticker < 0 && at.name < 0) {
    throw new Error('holdings CSV: no StockTicker/SecurityName column (is this the SP Funds TidalFG download?)');
  }

  const rows: SheetRow[] = [];
  let asOfDate: string | null = null;
  let netAssets: number | null = null;
  let sharesOutstanding: number | null = null;
  let creationUnits: number | null = null;
  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index];
    const pick = (position: number): string => (position >= 0 && position < cells.length ? cleanText(cells[position]) : '');
    const ticker = pick(at.ticker);
    const name = pick(at.name);
    if (!ticker && !name) continue;
    if (!asOfDate) asOfDate = toIsoDate(pick(at.date));
    if (netAssets === null) netAssets = numberOrNull(pick(at.netAssets));
    if (sharesOutstanding === null) sharesOutstanding = numberOrNull(pick(at.sharesOutstanding));
    if (creationUnits === null) creationUnits = numberOrNull(pick(at.creationUnits));
    const marketValue = numberOrNull(pick(at.marketValue));
    rows.push({
      Name: name,
      Ticker: ticker,
      Identifier: pick(at.cusip) || ticker,
      Weight: normalizeWeightText(pick(at.weight)),
      'Market Value': marketValue === null ? '' : String(marketValue),
      'Shares Held': pick(at.shares),
      'Asset Category': spFundsAssetCategory(ticker, name),
    });
  }
  return { headers: [...HOLDINGS_HEADERS], rows, asOfDate, netAssets, sharesOutstanding, creationUnits, totalRows: rows.length };
}

// ---------------------------------------------------------------------------
// Yahoo Finance chart feed
// ---------------------------------------------------------------------------

export function parseYahooChart(json: unknown): ParsedChart {
  const result = (json as JsonRecord | undefined)?.['chart']
    ? (((json as JsonRecord)['chart'] as JsonRecord)['result'] as JsonRecord[] | undefined)?.[0]
    : undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result['meta'] ?? {}) as JsonRecord;
  const timestamps = (result['timestamp'] as number[] | undefined) ?? [];
  const quote = (((result['indicators'] as JsonRecord | undefined)?.['quote'] as JsonRecord[] | undefined)?.[0] ?? {}) as JsonRecord;
  const adjClose = (((result['indicators'] as JsonRecord | undefined)?.['adjclose'] as JsonRecord[] | undefined)?.[0]?.['adjclose'] as Array<number | null> | undefined) ?? [];
  const days: ChartDay[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const close = numberOrNull(((quote['close'] as Array<number | null> | undefined) ?? [])[index]);
    const adjusted = numberOrNull(adjClose[index]);
    if (close === null && adjusted === null) continue;
    days.push({
      date: epochToIsoDate(timestamps[index]),
      close: round(close ?? adjusted ?? 0, 2),
      // Yahoo recomputes the adjusted series on every request: round it, or the
      // published file would churn forever on a last-digit difference.
      adjClose: round(adjusted ?? close ?? 0, 2),
      volume: numberOrNull(((quote['volume'] as Array<number | null> | undefined) ?? [])[index]) ?? 0,
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const dividends: Dividend[] = [];
  const events = ((result['events'] as JsonRecord | undefined)?.['dividends'] ?? {}) as Record<string, JsonRecord>;
  for (const key of Object.keys(events)) {
    const amount = numberOrNull(events[key]?.['amount']);
    const epoch = numberOrNull(events[key]?.['date']);
    if (amount === null || epoch === null) continue;
    dividends.push({ epoch, amount, exDate: epochToIsoDate(epoch), recordDate: null, payDate: null });
  }
  dividends.sort((a, b) => b.epoch - a.epoch);

  const exchange = cleanText(meta['fullExchangeName'] ?? meta['exchangeName'] ?? '') || null;
  const firstTradeDate = numberOrNull(meta['firstTradeDate']);
  const longName = cleanText(meta['longName'] ?? meta['shortName'] ?? '') || null;
  return {
    days,
    dividends,
    exchange,
    firstTradeDate: firstTradeDate === null ? null : epochToIsoDate(firstTradeDate),
    longName,
  };
}

export function historyRow(day: ChartDay): SheetRow {
  return { Date: formatSheetDate(day.date), Close: String(day.close), 'Adj Close': String(day.adjClose), Volume: String(day.volume) };
}

/** History sheet rows: oldest first, `Sep 30 2026` dates, like the sibling feeds. */
export function historyRowsFromDays(days: ChartDay[]): SheetRow[] {
  return [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map(historyRow);
}

/** A published history row (any date style, any order) back as a chart day, or null when it has no date. */
export function dayFromHistoryRow(row: SheetRow): ChartDay | null {
  const date = toIsoDate(row['Date']);
  if (!date) return null;
  return {
    date,
    close: numberOrNull(row['Close']) ?? 0,
    adjClose: numberOrNull(row['Adj Close']) ?? 0,
    volume: numberOrNull(row['Volume']) ?? 0,
  };
}

/**
 * A shorter HISTORY_RANGE window must not erase what is already published: fresh days win
 * inside the window, published days older than the window are kept.
 */
export function mergeHistoryDays(fresh: ChartDay[], published: ChartDay[]): ChartDay[] {
  if (!fresh.length) return published;
  const oldest = fresh.reduce((min, day) => (day.date < min ? day.date : min), fresh[0].date);
  return [...fresh, ...published.filter((day) => day.date < oldest)];
}

/** Fold Yahoo dividends into the official distribution calendar (official rows win). */
export function mergeDividends(
  official: FundPage['distributions'],
  yahoo: Dividend[],
): Dividend[] {
  const merged = new Map<string, Dividend>();
  for (const row of official) {
    if (!row.exDate || row.amount === null) continue;
    merged.set(row.exDate, {
      epoch: Math.floor(Date.parse(`${row.exDate}T00:00:00Z`) / 1000),
      amount: row.amount,
      exDate: row.exDate,
      recordDate: row.recordDate,
      payDate: row.payDate,
    });
  }
  for (const dividend of yahoo) {
    if (!dividend.exDate || merged.has(dividend.exDate)) continue;
    merged.set(dividend.exDate, dividend);
  }
  return [...merged.values()].sort((a, b) => b.epoch - a.epoch);
}

// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P (holdings fallback)
// ---------------------------------------------------------------------------

/** Holding tickers keep their class-share markers (BRK-B, BF/A, SCE^L). */
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

/** Security names compare with '&' spelled out and all punctuation collapsed. */
export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '').replace(/&/g, ' and ').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const normalized = text.replace(/\b(?:INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|AG|NV|CLASS [A-Z]|COM|COMMON STOCK|REIT|TRUST|FUND|ETF)\b/g, ' ');
  return (normalized.replace(/\s+/g, ' ').trim() || text);
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(decodeXml(match[1])) : '';
}

export type NportHolding = SheetRow;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string | null;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

/**
 * Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only), the
 * same shape the pinned siblings publish: identifiers, percent weight, USD value
 * and balance per `invstOrSec` block.
 */
export function parseNport(xml: string): ParsedNport {
  const body = xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1'); // strip optional namespace prefixes
  const genInfo = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(body)?.[1] ?? String(body).slice(0, 4000);
  const fundInfo = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(body)?.[1] ?? '';
  const holdings: NportHolding[] = [];
  let totalValue = 0;
  for (const block of body.matchAll(/<invstOrSec\b[^>]*>([\s\S]*?)<\/invstOrSec>/gi)) {
    const blockBody = block[1];
    const name = tagValue(blockBody, 'name') || tagValue(blockBody, 'title') || '—';
    const cusip = tagValue(blockBody, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      for (const match of blockBody.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(match[2]);
        if (identifier) break;
      }
    }
    const value = numberOrNull((/<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(blockBody)?.[1]) ?? tagValue(blockBody, 'curVal'));
    const weight = numberOrNull(tagValue(blockBody, 'pctVal'));
    const balance = numberOrNull(tagValue(blockBody, 'balance'));
    holdings.push({
      Name: name,
      Ticker: cleanHoldingTicker(tagValue(blockBody, 'ticker')) || '—',
      Identifier: identifier || '—',
      Weight: weight === null ? '' : String(weight),
      'Market Value': value === null ? '' : String(value),
      'Shares Held': balance === null ? '—' : String(balance),
      'Asset Category': tagValue(blockBody, 'assetCat') || '—',
    });
    if (value !== null) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId').toUpperCase(),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(tagValue(fundInfo, 'netAssets')),
  };
}

export type SecSeriesRef = { cik: string; seriesId: string; classId: string };

/** EDGAR's authoritative ticker -> registrant/series table for funds and classes. */
export function parseFundTickerMap(payload: JsonRecord): Map<string, SecSeriesRef> {
  const map = new Map<string, SecSeriesRef>();
  const fields: string[] = Array.isArray(payload?.['fields']) ? (payload['fields'] as unknown[]).map((field) => cleanText(field)) : [];
  const rows: unknown[] = Array.isArray(payload?.['data']) ? (payload['data'] as unknown[]) : [];
  const at = (row: unknown[], field: string): string => cleanText(row[fields.indexOf(field)]);
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const ticker = sanitizeTicker(at(raw, 'symbol'));
    const cik = at(raw, 'cik').replace(/\D/g, '');
    if (!ticker || !cik || Number(cik) === 0 || map.has(ticker)) continue;
    map.set(ticker, {
      cik: cik.padStart(10, '0'),
      seriesId: at(raw, 'seriesId').toUpperCase(),
      classId: at(raw, 'classId').toUpperCase(),
    });
  }
  return map;
}

/** Exchange-listed company tickers, used to fill N-PORT holdings that only name the issuer. */
export function parseCompanyTickerMap(payload: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of Object.values(payload ?? {})) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as JsonRecord;
    const ticker = cleanHoldingTicker(record['ticker']);
    const name = cleanText(record['title']);
    if (!ticker || !name) continue;
    for (const key of [normalizeHoldingName(name), normalizeHoldingNameCore(name)]) {
      if (key && !map.has(key)) map.set(key, ticker);
    }
  }
  return map;
}

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

export function nportUrlFor(cik: string, accession: string): string {
  if (!/^\d+$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new Error('EDGAR: invalid accession or CIK');
  return `${EDGAR_ARCHIVES}/${Number(cik)}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(payload: JsonRecord): NportAccession[] {
  const recent = (((payload?.['filings'] as JsonRecord | undefined)?.['recent'] ?? {}) as JsonRecord);
  const cik = cleanText(payload?.['cik']).replace(/\D/g, '');
  const forms = (recent['form'] as unknown[] | undefined) ?? [];
  const result: NportAccession[] = [];
  for (let index = 0; index < forms.length; index += 1) {
    const form = cleanText(forms[index]);
    const accession = cleanText((recent['accessionNumber'] as unknown[] | undefined)?.[index]);
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    result.push({
      accession,
      filed: cleanText((recent['filingDate'] as unknown[] | undefined)?.[index]),
      reportDate: cleanText((recent['reportDate'] as unknown[] | undefined)?.[index]),
      url: nportUrlFor(cik, accession),
    });
  }
  return result;
}

/**
 * EDGAR accepts a fund series ID where a CIK normally goes, which returns the
 * NPORT-P filings of that one series: no guessing across a trust's other funds.
 */
export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  return `${EDGAR_BROWSE_URL}?${new URLSearchParams({
    action: 'getcompany', CIK: seriesId.toUpperCase(), type: 'NPORT-P', dateb: '', owner: 'include', count: String(count), output: 'atom',
  })}`;
}

export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const cik = /\/edgar\/data\/(\d+)\//.exec(tagValue(body, 'filing-href'))?.[1] ?? accession.slice(0, 10);
    result.push({ accession, filed: tagValue(body, 'filing-date'), reportDate: tagValue(body, 'period'), url: nportUrlFor(cik, accession) });
  }
  return result;
}

export function matchesNportFund(parsed: ParsedNport, ticker: string, name: string | null, ref: SecSeriesRef | null, trustCik: string): boolean {
  if (Number(parsed.regCik) !== Number(ref?.cik || trustCik) || !parsed.repPdDate || !parsed.holdings.length) return false;
  if (ref?.seriesId) return parsed.seriesId.toUpperCase() === ref.seriesId;
  return Boolean(name) && normalizeHoldingName(parsed.seriesName) === normalizeHoldingName(name);
}

export function fillNportTickers(rows: NportHolding[], names: Map<string, string>): NportHolding[] {
  return rows.map((row) => {
    if (cleanHoldingTicker(row['Ticker']) || !/^(?:EC|EQ|EQUITY|EQUITIES|COMMON STOCK)$/i.test(row['Asset Category'] ?? '')) return row;
    const ticker = names.get(normalizeHoldingName(row['Name'])) ?? names.get(normalizeHoldingNameCore(row['Name']));
    return ticker ? { ...row, Ticker: ticker } : row;
  });
}

export type NportFallbackResult = { rows: NportHolding[]; asOfDate: string | null; source: string };

/**
 * Holdings fallback: the ETF's own series filing first (browse-edgar Atom feed
 * keyed by series ID), then the trust's submissions feed filtered by series name.
 */
export function createEdgarFallback(
  config: UpdaterConfig,
  transport: Transport,
  output: (message: string) => void = outputNote,
): (ticker: string, name: string | null) => Promise<NportFallbackResult | null> {
  let seriesTable: Promise<Map<string, SecSeriesRef>> | null = null;
  let companyTable: Promise<Map<string, string>> | null = null;
  const loadSeriesTable = () => seriesTable ??= transport(SEC_FUND_TICKERS_URL, 'fund ticker table', { headers: secHeaders(config) })
    .then((response) => response.json())
    .then(parseFundTickerMap)
    .catch((error) => { output(`[ edgar    ] fund ticker table: ${errorMessage(error)}`); return new Map<string, SecSeriesRef>(); });
  const loadCompanyTable = () => companyTable ??= transport(SEC_COMPANY_TICKERS_URL, 'company ticker table', { headers: secHeaders(config) })
    .then((response) => response.json())
    .then(parseCompanyTickerMap)
    .catch((error) => { output(`[ edgar    ] company ticker table: ${errorMessage(error)}`); return new Map<string, string>(); });

  return async (ticker: string, name: string | null): Promise<NportFallbackResult | null> => {
    const trust = trustForTicker(ticker);
    const ref = (await loadSeriesTable()).get(sanitizeTicker(ticker)) ?? null;
    // The registrants are verified: never silently publish another trust's filing.
    if (ref && ![TIDAL_TRUST.cik, SPFUNDS_TRUST.cik].some((cik) => Number(cik) === Number(ref.cik))) return null;
    let filings: NportAccession[] = [];
    if (ref?.seriesId) {
      try {
        filings = parseEdgarAtomFilings(await (await transport(edgarSeriesFilingsUrl(ref.seriesId), `${ticker} EDGAR series feed`, { headers: secHeaders(config) })).text());
      } catch (error) {
        output(`[ edgar    ] ${ticker} series: ${errorMessage(error)}`);
      }
    }
    if (!filings.length) {
      try {
        const payload = await (await transport(`${SEC_DATA_HOST}/submissions/CIK${trust.cik}.json`, `${ticker} EDGAR submissions`, { headers: secHeaders(config) })).json();
        filings = parseNportAccessions(payload as JsonRecord);
      } catch (error) {
        output(`[ edgar    ] ${ticker} submissions: ${errorMessage(error)}`);
        return null;
      }
    }
    for (const filing of filings.slice(0, ref?.seriesId ? 10 : 80)) {
      try {
        const parsed = parseNport(await (await transport(filing.url, `${ticker} N-PORT ${filing.accession}`, { headers: secHeaders(config) })).text());
        if (!matchesNportFund(parsed, ticker, name, ref, trust.cik)) continue;
        const rows = fillNportTickers(parsed.holdings, await loadCompanyTable());
        rows.sort((a, b) => wNumber(b['Weight']) - wNumber(a['Weight']) || String(a['Identifier']).localeCompare(String(b['Identifier'])) || String(a['Name']).localeCompare(String(b['Name'])));
        return { rows, asOfDate: parsed.repPdDate, source: filing.url };
      } catch (error) {
        output(`[ edgar    ] ${ticker} ${filing.accession}: ${errorMessage(error)}`);
      }
    }
    return null;
  };
}

function wNumber(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

export function cumulativeFromAnnualized(annualized: number | null, years: number): number | null {
  if (annualized === null) return null;
  if (years <= 1) return annualized;
  return round(((1 + annualized / 100) ** years - 1) * 100, 2);
}

export function annualizedFromCumulative(cumulative: number | null, years: number): number | null {
  if (cumulative === null) return null;
  if (years <= 1) return cumulative;
  const base = 1 + cumulative / 100;
  if (base <= 0) return null;
  return round((base ** (1 / years) - 1) * 100, 2);
}

/** Provider label -> payments per year. */
export function paymentsPerYear(frequency: string | null | undefined): number | null {
  const text = cleanText(frequency).toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!text) return null;
  if (text === 'monthly') return 12;
  if (text === 'quarterly') return 4;
  if (text === 'semi-annually' || text === 'semiannually' || text === 'semi-annual' || text === 'semiannual') return 2;
  if (text === 'annually' || text === 'annual') return 1;
  if (text === 'weekly') return 52;
  if (text === 'bi-monthly') return 6;
  return null;
}

/**
 * Distribution frequency derived from the fund's own published ex-dates. SP Funds
 * publishes a payment calendar, not a frequency label; this only ever reports
 * what the dates themselves show and is documented as derived.
 */
export function inferDistributionFrequency(exDates: string[], now: Date = new Date()): string | null {
  const cutoff = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recent = exDates.map((value) => toIsoDate(value)).filter((value): value is string => Boolean(value) && value! >= cutoff).sort();
  if (recent.length < 3) return null;
  const unique = [...new Set(recent)].slice(-12);
  if (unique.length <= 1) return null;
  const gaps: number[] = [];
  for (let index = 1; index < unique.length; index += 1) {
    const days = (Date.parse(unique[index]) - Date.parse(unique[index - 1])) / 86_400_000;
    if (days > 0) gaps.push(days);
  }
  if (!gaps.length) return null;
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean >= 20 && mean <= 40) return 'Monthly';
  if (mean >= 70 && mean <= 110) return 'Quarterly';
  if (mean >= 150 && mean <= 215) return 'Semi-annually';
  if (mean >= 330 && mean <= 400) return 'Annually';
  return null;
}

/** The date of the provider performance table the returns come from (never the NAV date), or null. */
export function performanceAsOf(returns: OfficialReturnRow): string | null {
  const value = returns.asOfDate;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export type DerivedMetrics = {
  ytd: number | null;
  tr1y: number | null;
  tr3y: number | null;
  tr5y: number | null;
  tr10y: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  dividendYield: number | null;
  dividendYieldText: string;
  secYield: number | null;
  secYieldText: string;
  returnsBasis: string;
  performanceAsOf: string | null;
};

/**
 * The published catalog metrics. Official returns come straight from the fund
 * page performance tables (NAV row) and are never re-derived; the distribution
 * rate is the indicated latest distribution annualised over NAV, exactly as the
 * sibling feeds document their derived yield.
 */
export function deriveMetrics(
  returns: OfficialReturnRow,
  dividendFrequency: string | null,
  latestDistribution: number | null,
  navValue: number | null,
  secYield: number | null,
): DerivedMetrics {
  const payments = paymentsPerYear(dividendFrequency);
  const dividendYield = latestDistribution !== null && latestDistribution > 0 && navValue !== null && navValue > 0 && payments !== null
    ? round((latestDistribution * payments * 100) / navValue, 2)
    : null;
  return {
    ytd: returns.ytd,
    tr1y: returns.yr1,
    tr3y: cumulativeFromAnnualized(returns.yr3, 3),
    tr5y: cumulativeFromAnnualized(returns.yr5, 5),
    tr10y: cumulativeFromAnnualized(returns.yr10, 10),
    cagr3y: returns.yr3,
    cagr5y: returns.yr5,
    cagr10y: returns.yr10,
    siAnn: returns.sinceInception,
    dividendYield,
    dividendYieldText: formatPercentText(dividendYield),
    secYield,
    secYieldText: secYield === null ? '—' : `${secYield.toFixed(2)}%`,
    returnsBasis: 'official SP Funds month-end NAV total returns (fund page Performance Statistics table, fund NAV row); cumulative 3/5/10-year figures derived exactly from the published annualized returns',
    performanceAsOf: performanceAsOf(returns),
  };
}

// ---------------------------------------------------------------------------
// Request pacing, retries and transport
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * One independent paced lane per worker slot. A single shared timestamp would cap
 * the whole run at one request per REQUEST_SLEEP no matter how high CONCURRENCY
 * is; each lane reserves its own slot synchronously before awaiting the sleep.
 */
export function createRequestGate(concurrency: number, sleepMs: number, now = Date.now, wait = sleep) {
  const lanes = new Array(Math.max(1, concurrency)).fill(0);
  let reserved = 0;
  return async (): Promise<void> => {
    const timestamp = now();
    const lane = reserved % lanes.length;
    reserved += 1;
    const start = Math.max(timestamp, lanes[lane]);
    lanes[lane] = start + sleepMs;
    const delay = start - timestamp;
    if (delay > 0) await wait(delay);
  };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type Transport = (url: string, label: string, init?: RequestInit) => Promise<Response>;

export function browserHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (compatible; SP-Funds static feed; https://github.com/daggerok/SP-Funds)',
    Accept: 'text/html,application/xhtml+xml,application/json,text/csv,*/*;q=0.8',
  };
}

export function yahooHeaders(): Record<string, string> {
  return { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
}

export function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,application/xml,text/xml,*/*' };
}

export function createTransport(config: UpdaterConfig, gate: () => Promise<void>, fetcher: Fetcher = fetch, wait = sleep): Transport {
  return async (url: string, label: string, init: RequestInit = {}): Promise<Response> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      await gate();
      let response: Response | null = null;
      try {
        response = await fetcher(url, { ...init, signal: AbortSignal.timeout(45_000) });
      } catch (error) {
        lastError = error;
      }
      if (response) {
        if (response.ok) return response;
        // A permanent status (403/404/...) is never retried: only transient ones are.
        if (!RETRY_STATUS.has(response.status)) throw new Error(`${label}: HTTP ${response.status}`);
        lastError = new Error(`${label}: HTTP ${response.status}`);
      }
      if (attempt === config.maxRetries) break;
      outputNote(`[ ${'retry'.padEnd(9)}] ${label}: ${errorMessage(lastError)}, retry ${attempt + 1}/${config.maxRetries}`);
      await wait(500 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(`${label}: request failed`);
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Deterministic writes
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Compare the published content ignoring run timestamps, so a no-op run keeps `git diff` clean. */
export function samePublishedContent(previous: string, value: unknown): boolean {
  const strip = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(strip);
    if (input && typeof input === 'object') {
      const out: JsonRecord = {};
      for (const [key, entry] of Object.entries(input as JsonRecord)) {
        if (key === 'generatedAt' || key === 'catalogReadAt') continue;
        out[key] = strip(entry);
      }
      return out;
    }
    return input;
  };
  try {
    return stableStringify(strip(JSON.parse(previous))) === stableStringify(strip(value));
  } catch {
    return false;
  }
}

export async function writeIfChanged(file: URL | string, value: unknown): Promise<boolean> {
  const target = file instanceof URL ? file : new URL(file);
  const content = stableStringify(value);
  try {
    const previous = await readFile(target, 'utf8');
    if (samePublishedContent(previous, value)) return false;
  } catch {
    // Missing file: write it.
  }
  await mkdir(dirname(target.pathname), { recursive: true });
  // tmp file + rename: a crash never leaves a half-written JSON behind.
  const tmp = `${target.pathname}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
  return true;
}

export function splitPages<T>(rows: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += pageSize) pages.push(rows.slice(index, index + pageSize));
  return pages;
}

export function pageFileName(index: number): string {
  return `${String(index).padStart(3, '0')}.json`;
}

export type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string | null };

export function buildPages(
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: SheetRow[],
  pageSize: number,
  asOfDate: string | null = null,
): Array<{ name: string; payload: JsonRecord }> {
  return splitPages(rows, pageSize).map((page, index) => ({
    name: pageFileName(index + 1),
    payload: {
      ticker,
      kind,
      page: index + 1,
      pageSize,
      totalRows: rows.length,
      headers,
      // Header-keyed objects, exactly like the sibling feeds: the client maps
      // every row through `header -> String(row[header] ?? '')`.
      rows: page,
      asOfDate,
    },
  }));
}

export async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: SheetRow[],
  pageSize: number,
  asOfDate: string | null,
  prune = true,
): Promise<PageManifest> {
  const pages = buildPages(ticker, kind, headers, rows, pageSize, asOfDate);
  for (const page of pages) await writeIfChanged(new URL(page.name, dir), page.payload);
  const manifest: PageManifest = { pages: pages.map((page) => page.name), pageSize, totalRows: rows.length, asOfDate };
  // updateFund passes prune=false and prunes only AFTER the new meta.json is written.
  if (prune) await prunePages(dir, manifest);
  return manifest;
}

/** Remove page files beyond the freshly written count so a shrinking fund leaves no orphans. */
export async function prunePages(dir: URL, manifest: PageManifest): Promise<void> {
  const expected = new Set(manifest.pages);
  try {
    for (const name of await readdir(dir)) {
      if (/^\d{3}\.json$/.test(name) && !expected.has(name)) await rm(new URL(name, dir), { force: true });
    }
  } catch {
    // Directory does not exist yet; nothing to prune.
  }
}

export async function readPreviousPages(
  dir: URL,
  manifest: PageManifest | null = null,
): Promise<{ headers: string[]; rows: SheetRow[]; manifest: PageManifest | null }> {
  const headers: string[] = [];
  const rows: SheetRow[] = [];
  try {
    for (const name of (await readdir(dir)).filter((entry) => /^\d{3}\.json$/.test(entry)).sort()) {
      const payload = JSON.parse(await readFile(new URL(name, dir), 'utf8')) as JsonRecord;
      const pageHeaders = (payload['headers'] as string[] | undefined) ?? [];
      if (!headers.length) headers.push(...pageHeaders);
      for (const row of (payload['rows'] as Array<unknown> | undefined) ?? []) {
        const record: SheetRow = {};
        if (Array.isArray(row)) {
          pageHeaders.forEach((header, index) => { record[header] = row[index] ?? ''; });
        } else {
          const object = (row ?? {}) as SheetRow;
          pageHeaders.forEach((header) => { record[header] = object[header] ?? ''; });
        }
        rows.push(record);
      }
    }
  } catch {
    // No previous pages.
  }
  return { headers, rows, manifest };
}

// ---------------------------------------------------------------------------
// Selection / filters
// ---------------------------------------------------------------------------

export function matchesRange(value: number | null | undefined, range: Range | undefined): boolean {
  if (!range) return true;
  if (value === null || value === undefined) return false;
  return value >= range.min && value <= range.max;
}

export type SelectionEntry = {
  ticker: string;
  aumValue: number | null;
  terValue: number | null;
  secYield: number | null;
  dividendYield: number | null;
  returns: OfficialReturnRow;
  metrics: DerivedMetrics | null;
};

export function fundFilterReasons(entry: SelectionEntry, config: UpdaterConfig): string[] {
  const reasons: string[] = [];
  if (!matchesRange(entry.aumValue, config.aumRange)) reasons.push('aum');
  if (!matchesRange(entry.terValue, config.terRange)) reasons.push('ter');
  if (!matchesRange(entry.secYield, config.secYieldRange)) reasons.push('sec_yield');
  if (!matchesRange(entry.dividendYield, config.dividendYieldRange)) reasons.push('dividend_yield');
  for (const period of RETURN_PERIODS) {
    const range = config.performanceRanges[period];
    if (range && !matchesRange(entry.returns[periodKey(period)], range)) reasons.push(`performance_${period.toLowerCase()}`);
  }
  for (const period of RETURN_PERIODS) {
    const range = config.totalReturnRanges[period];
    if (range) {
      const value = entry.metrics ? entry.metrics[periodKey(period)] : null;
      if (!matchesRange(value, range)) reasons.push(`total_return_${period.toLowerCase()}`);
    }
  }
  return reasons;
}

/** The previously published catalog, used to evaluate the selection filters. */
export async function readPreviousIndex(apiRoot: URL): Promise<Map<string, JsonRecord>> {
  try {
    const payload = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8')) as JsonRecord;
    const map = new Map<string, JsonRecord>();
    for (const entry of (payload['funds'] as JsonRecord[] | undefined) ?? []) {
      const ticker = sanitizeTicker(entry['ticker']);
      if (ticker) map.set(ticker, entry);
    }
    return map;
  } catch {
    return new Map<string, JsonRecord>();
  }
}

/**
 * Selection filters run against the previously published facts, because a fund
 * page has to be fetched before its fresh AUM/TER/yields exist. A fund with no
 * published entry yet is never filtered out: the first run must be able to
 * publish the facts a later run filters on.
 */
export function selectionEntryFromIndex(entry: JsonRecord | undefined): SelectionEntry | null {
  if (!entry) return null;
  const monthEnd = ((entry['returns'] as JsonRecord | undefined)?.['monthEnd'] ?? {}) as JsonRecord;
  const returns = emptyReturns();
  returns.asOfDate = (monthEnd['asOfDate'] as string | null) ?? null;
  returns.ytd = numberOrNull(monthEnd['ytd']);
  returns.yr1 = numberOrNull(monthEnd['yr1']);
  returns.yr3 = numberOrNull(monthEnd['yr3']);
  returns.yr5 = numberOrNull(monthEnd['yr5']);
  returns.yr10 = numberOrNull(monthEnd['yr10']);
  returns.sinceInception = numberOrNull(monthEnd['sinceInception']);
  const metrics = (entry['metrics'] ?? null) as DerivedMetrics | null;
  return {
    ticker: sanitizeTicker(entry['ticker']),
    aumValue: numberOrNull(entry['aumValue']),
    terValue: numberOrNull(entry['terValue']),
    secYield: metrics ? numberOrNull(metrics.secYield) : null,
    dividendYield: metrics ? numberOrNull(metrics.dividendYield) : null,
    returns,
    metrics,
  };
}

export function periodKey(period: ReturnPeriod): NumericReturnKey {
  if (period === 'YTD') return 'ytd';
  if (period === '1Y') return 'yr1';
  if (period === '3Y') return 'yr3';
  if (period === '5Y') return 'yr5';
  return 'yr10';
}

export function batchSelection(funds: CatalogFund[], maxFetches: number, cursor: string | null): CatalogFund[] {
  // Always a copy: the worker pool shifts this array, the catalog must survive.
  if (!maxFetches || maxFetches <= 0) return [...funds];
  if (!cursor) return funds.slice(0, maxFetches);
  const start = funds.findIndex((fund) => fund.ticker === cursor);
  const ordered = start >= 0 ? [...funds.slice(start + 1), ...funds.slice(0, start + 1)] : funds;
  return ordered.slice(0, maxFetches);
}

// ---------------------------------------------------------------------------
// Console contract
// ---------------------------------------------------------------------------

/** Presentation only: no requests, writes or filtering happen in this block. */
export function outputClean(value: unknown): string {
  return String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
}

export function outputVerbose(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env['VERBOSE'] ?? ''));
}

export function outputNote(message: string): void {
  if (outputVerbose()) console.warn(message);
}

function envNameFor(key: string): string {
  const aliases: Record<string, string> = {
    requestSleep: 'REQUEST_SLEEP', skipSpFunds: 'SKIP_SPFUNDS', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
  };
  return aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

export function outputConfigEntries(config: JsonRecord): Array<[string, string]> {
  const values = new Map<string, string>();
  const range = (value: unknown): string => {
    const record = (value ?? {}) as JsonRecord;
    if (record['source']) return String(record['source']);
    const min = Number(record['min']);
    const max = Number(record['max']);
    return `${Number.isFinite(min) ? min : ''}:${Number.isFinite(max) ? max : ''}`;
  };
  for (const [key, value] of Object.entries(config)) {
    const name = envNameFor(key);
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of RETURN_PERIODS) values.set(`${name}_${period}`, range((value as RangeMap | undefined)?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a);
    const bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}

export function outputPrintConfig(brand: string, config: JsonRecord, env: Record<string, string | undefined> = process.env): void {
  const entries: Array<[string, string]> = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose(env))]];
  console.log(`[ config   ] ${brand} updater:\n${entries
    .map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key) ? '<redacted>' : outputClean(value)}`)
    .join('\n')}`);
}

export function outputPrintFilter(selected: number, total: number): void {
  console.log(`[ filter   ] ${selected} of ${total} funds pass filters`);
}

export function outputCount(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  const record = (value ?? {}) as JsonRecord;
  return record['totalRows'] ?? (Array.isArray(record['rows']) ? (record['rows'] as unknown[]).length : null) ?? null;
}

export function outputScalar(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    return record['display'] ?? record['value'] ?? null;
  }
  return value;
}

/** Monetary display for the console line; the string `'null'` means unavailable. */
export function outputMoney(value: unknown): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = /^([+-]?[\d.]+)([KMBT])?$/i.exec(text);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (AMOUNT_SUFFIXES[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}

export function outputFundLine(index: number, total: number, ticker: string, status: string, data: JsonRecord = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = (data['metrics'] ?? {}) as JsonRecord;
  const yields = (data['yields'] ?? {}) as JsonRecord;
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const detail = [
    field('history', outputCount(data['history'] ?? data['historyCount'])),
    field('holdings', outputCount(data['holdings'] ?? data['holdingsCount'])),
    field('divs', outputCount(data['distributions'])),
    field('netAssets', outputMoney(data['netAssets'] ?? data['aum'])),
    field('div', outputScalar(data['dividendYield'] ?? yields['dividendYield'] ?? metrics['dividendYield'])),
    field('sec', outputScalar(data['secYield'] ?? yields['secYield'] ?? metrics['secYield'])),
  ].filter((part) => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}

export function outputCreateReporter(total: number) {
  let completed = 0;
  return {
    result(ticker: string, status: string, data: JsonRecord = {}, reason?: unknown): void {
      console.log(outputFundLine(++completed, total, ticker, status, data, reason));
    },
  };
}

export async function outputWriteSummary(lines: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const path = env['GITHUB_STEP_SUMMARY'];
  if (!path) return;
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Per-fund processing
// ---------------------------------------------------------------------------

export const API_ROOT = new URL('../api/spfunds/', import.meta.url);
export const STATE_FILE = 'update-state.json';

/** Built-in catalog used when the issuer page cannot be read (name comes from the fund page). */
export const FALLBACK_CATALOG: CatalogFund[] = SPFUNDS_TICKERS.map((ticker) => ({
  ticker,
  name: null,
  category: null,
  fundPage: fundPageUrl(ticker),
  inceptionDate: null,
  terValue: null,
  netTerValue: null,
  aumValue: null,
  officialReturns: emptyReturns(),
}));

export type ProviderState = { spFunds: boolean; yahoo: boolean; edgar: boolean; retained: string[] };

export type UpdateStatus = 'updated' | 'unchanged' | 'skipped';
export type FundOutcome = {
  entry: JsonRecord;
  providers: ProviderState;
  reason?: string;
  written: boolean;
  status: UpdateStatus;
  /** Sources that failed for this fund; non-empty means the fund was kept as published. */
  failedSources?: string[];
};

export const RETURNS_BASIS = 'official SP Funds month-end NAV total returns (fund page Performance Statistics table, fund NAV row); cumulative 3/5/10-year figures derived exactly from the published annualized returns';

/** A metrics object with every key present and nothing known yet (null, never 0). */
export function emptyMetrics(): DerivedMetrics {
  return {
    ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null,
    dividendYield: null, dividendYieldText: '—', secYield: null, secYieldText: '—',
    returnsBasis: RETURNS_BASIS, performanceAsOf: null,
  };
}

/** Rebuild a catalog row from a published meta.json (skipped/retained funds). */
export function entryFromMeta(ticker: string, meta: JsonRecord): JsonRecord {
  const distributions = (meta['distributions'] ?? {}) as JsonRecord;
  const exchange = (meta['exchange'] as string | null) ?? null;
  const aumValue = numberOrNull(meta['aumValue']);
  return {
    ticker,
    name: (meta['name'] as string | null) ?? null,
    category: (meta['category'] as string | null) ?? null,
    fundPage: (meta['fundPage'] as string | null) ?? fundPageUrl(ticker),
    dataFile: (meta['dataFile'] as string | null) ?? `funds/${ticker}/meta.json`,
    ter: meta['ter'] ?? null,
    terValue: meta['terValue'] ?? null,
    terGrossValue: meta['terGrossValue'] ?? null,
    nav: meta['nav'] ?? null,
    navValue: meta['navValue'] ?? null,
    aum: meta['aum'] ?? null,
    aumValue: aumValue === null ? null : round(aumValue, 2),
    asOfDate: meta['asOfDate'] ?? null,
    inceptionDate: meta['inceptionDate'] ?? null,
    exchange,
    closePrice: meta['closePrice'] ?? null,
    closePriceValue: meta['closePriceValue'] !== undefined ? meta['closePriceValue'] : parseMoneyNumber(meta['closePrice']),
    closePriceAsOfDate: (meta['closePriceAsOfDate'] as string | null) ?? null,
    premiumDiscount: meta['premiumDiscount'] ?? null,
    premiumDiscountValue: meta['premiumDiscountValue'] !== undefined ? meta['premiumDiscountValue'] : numberOrNull(meta['premiumDiscount']),
    cusip: (meta['cusip'] as string | null) ?? null,
    isin: (meta['isin'] as string | null) ?? null,
    distributions: { frequency: distributions['frequency'] ?? null, exDate: distributions['exDate'] ?? null, dividend: distributions['dividend'] ?? null },
    returns: (meta['returns'] as JsonRecord | undefined) ?? { monthEnd: emptyReturns(), quarterEnd: emptyReturns() },
    metrics: (meta['metrics'] as JsonRecord | undefined) ?? emptyMetrics(),
    holdings: Number((meta['holdings'] as JsonRecord | undefined)?.['totalRows'] ?? 0),
    history: Number((meta['history'] as JsonRecord | undefined)?.['totalRows'] ?? 0),
  };
}

/** A catalog row for a fund that has no funds/<T>/meta.json yet: `dataFile: null`, full empty metrics. */
export function placeholderEntry(ticker: string, fundPage: string | null): JsonRecord {
  return { ...entryFromMeta(ticker, { fundPage }), dataFile: null };
}

/**
 * The published distribution calendar: the freshly parsed one, or the previously
 * published rows when a transient failure left nothing to parse.
 */
export function publishDistributions(
  mergedDividends: Dividend[],
  frequency: string | null,
  latest: Dividend | null,
  previousMeta: JsonRecord,
): JsonRecord {
  const previous = (previousMeta['distributions'] ?? {}) as JsonRecord;
  const headers = ['Ex-Date', 'Record Date', 'Payable Date', 'Amount'];
  const rows = mergedDividends.length
    ? mergedDividends.slice(0, 60).map((row) => [row.exDate, row.recordDate ?? '', row.payDate ?? '', row.amount === null ? '' : String(row.amount)])
    : ((previous['rows'] as string[][] | undefined) ?? []);
  return {
    // Previous values stand in only when there is no calendar at all (source failed), never for an honest null.
    frequency: mergedDividends.length ? frequency : (frequency ?? (previous['frequency'] as string | null) ?? null),
    exDate: latest?.exDate ?? (previous['exDate'] as string | null) ?? null,
    dividend: latest ? String(latest.amount) : ((previous['dividend'] as string | null) ?? null),
    paymentsPerYear: paymentsPerYear(mergedDividends.length ? frequency : (frequency ?? (previous['frequency'] as string | null) ?? null)),
    headers: (previous['headers'] as string[] | undefined) ?? headers,
    rows,
  };
}

/** Content digest of a published fund directory, timestamps ignored (updated vs unchanged). */
export async function fundDigest(apiRoot: URL, ticker: string): Promise<string> {
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  const hash = createHash('sha256');
  const collect = async (base: URL, prefix: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.map((item) => ({ name: item.name, isDirectory: () => item.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await collect(new URL(`${entry.name}/`, base), `${path}/`);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      hash.update(path);
      try {
        hash.update(stableContentKey(JSON.parse(await readFile(new URL(entry.name, base), 'utf8'))));
      } catch {
        hash.update('unparseable');
      }
    }
  };
  await collect(dir, '');
  return hash.digest('hex');
}

/** JSON key sorted, timestamps stripped: the byte-churn-free identity of a document. */
export function stableContentKey(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as JsonRecord).sort()
        .filter((key) => key !== 'generatedAt' && key !== 'catalogReadAt')
        .map((key) => [key, stable((input as JsonRecord)[key])]));
    }
    return input;
  };
  return JSON.stringify(stable(value)) ?? 'null';
}

type PreviousFund = { meta: JsonRecord | null; holdings: { headers: string[]; rows: SheetRow[]; asOfDate: string | null }; history: { rows: SheetRow[]; asOfDate: string | null } };

async function readPreviousFund(apiRoot: URL, ticker: string): Promise<PreviousFund> {
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  let meta: JsonRecord | null = null;
  try {
    meta = JSON.parse(await readFile(new URL('meta.json', dir), 'utf8')) as JsonRecord;
  } catch {
    meta = null;
  }
  const holdings = await readPreviousPages(new URL('holdings/', dir), (meta?.['holdings'] as PageManifest | undefined) ?? null);
  const history = await readPreviousPages(new URL('history/', dir), (meta?.['history'] as PageManifest | undefined) ?? null);
  return {
    meta,
    holdings: { headers: holdings.headers, rows: holdings.rows, asOfDate: holdings.manifest?.asOfDate ?? null },
    history: { rows: history.rows, asOfDate: history.manifest?.asOfDate ?? null },
  };
}

/** Fold a fund page's two-column tables into the shared details shape. */
export function detailsFromPage(page: FundPage, ticker: string): FundDetails {
  const inception = toIsoDate(lookupPattern(page.details, /fund inception/i) ?? '');
  const gross = numberOrNull(lookupPattern(page.details, /gross expense/i));
  // terValue is the NET (or the only published) expense ratio, terGrossValue the gross one when published.
  const ter = numberOrNull(lookupPattern(page.details, /net expense/i))
    ?? numberOrNull(lookupPattern(new Map([...page.details].filter(([key]) => !/gross/i.test(key))), /expense ratio/i));
  const cusip = cleanText(lookupPattern(page.details, /cusip/i)) || null;
  const exchange = cleanText(lookupPattern(page.details, /primary exchange/i)) || null;
  const secYield = numberOrNull(lookupPattern(page.details, /sec yield/i));
  const indexTicker = cleanText(lookupPattern(page.details, /index/i)) ?? ''; // not published by SP Funds
  const nav = parseMoneyNumber(lookupPattern(page.pricing, /^nav$/i));
  const netAssets = parseMoneyNumber(lookupPattern(page.pricing, /net assets/i));
  const shares = parseMoneyNumber(lookupPattern(page.pricing, /shares outstanding/i));
  const premiumDiscount = numberOrNull(lookupPattern(page.pricing, /premium\/?discount/i));
  const close = parseMoneyNumber(lookupPattern(page.pricing, /closing price/i));
  return {
    ticker,
    name: page.name,
    category: null,
    fundPage: fundPageUrl(ticker),
    inceptionDate: inception,
    terValue: ter,
    netTerValue: ter,
    terGrossValue: gross,
    closePriceValue: close,
    aumValue: netAssets === null ? null : round(netAssets, 2),
    officialReturns: page.monthEnd?.returns ?? emptyReturns(),
    cusip,
    isin: null,
    indexTicker: indexTicker || null,
    exchange,
    navValue: nav,
    navAsOfDate: page.pricingAsOf ?? null,
    secYield,
    distributionRate: null,
    frequency: inferDistributionFrequency(page.distributions.map((row) => row.exDate)),
    midpoint: shares !== null && nav !== null ? round(shares * nav, 6) : null,
    premiumDiscount,
  } as FundDetails & { closePrice?: number | null };
}

/** Previously published official distribution rows as dividends (used when the page lost its table). */
export function dividendsFromPublished(rows: unknown): FundPage['distributions'] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const cells = Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [];
    return { exDate: toIsoDate(cells[0]) ?? '', recordDate: toIsoDate(cells[1]), payDate: toIsoDate(cells[2]), amount: numberOrNull(cells[3]) };
  }).filter((row) => row.exDate);
}

export async function updateFund(
  catalogFund: CatalogFund,
  config: UpdaterConfig,
  apiRoot: URL,
  transport: Transport,
  edgar: ((ticker: string, name: string | null) => Promise<NportFallbackResult | null>) | null,
  now: Date,
): Promise<FundOutcome> {
  const ticker = sanitizeTicker(catalogFund.ticker);
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  const previous = await readPreviousFund(apiRoot, ticker);
  const providers: ProviderState = { spFunds: false, yahoo: false, edgar: false, retained: [] };
  // Sources that were attempted and failed. With a published fund this keeps the fund as it was:
  // every fund is either fully updated or fully kept, never a new column next to stale ones.
  const failedSources: string[] = [];

  // Both issuer switches off with something already published: keep every byte.
  if (config.skipSpFunds && config.skipYahoo && previous.meta) {
    return {
      entry: entryFromMeta(ticker, previous.meta),
      providers: { ...providers, retained: ['issuer page (SKIP_SPFUNDS)', 'holdings', 'history'] },
      reason: 'retained: SKIP_SPFUNDS+SKIP_YAHOO',
      written: false,
      status: 'unchanged',
    };
  }

  // 1) Official fund page: details, pricing, returns, distributions, documents.
  let page: FundPage | null = null;
  if (!config.skipSpFunds) {
    try {
      const response = await transport(catalogFund.fundPage || fundPageUrl(ticker), `${ticker} fund page`, { headers: browserHeaders() });
      page = parseFundPage(await response.text(), ticker);
      providers.spFunds = true;
    } catch (error) {
      providers.retained.push('issuer page');
      failedSources.push('issuer page');
      outputNote(`[ ${'issuer'.padEnd(9)}] ${ticker}: fund page unavailable (${errorMessage(error)}), keeping the published data`);
    }
  } else {
    providers.retained.push('issuer page (SKIP_SPFUNDS)');
  }

  // 2) Official daily holdings CSV, then the SEC N-PORT-P fallback, then previous pages.
  let holdingsRows: SheetRow[] | null = null;
  let holdingsAsOf: string | null = null;
  let holdingsSource: string | null = null;
  let csvTotals: { netAssets: number | null; sharesOutstanding: number | null } = { netAssets: null, sharesOutstanding: null };
  if (!config.skipSpFunds) {
    try {
      const response = await transport(holdingsCsvUrl(ticker), `${ticker} holdings CSV`, { headers: browserHeaders() });
      const parsed = parseSpFundsHoldingsCsv(await response.text());
      if (parsed.rows.length === 0) throw new Error('holdings CSV contained no positions');
      holdingsRows = parsed.rows;
      holdingsAsOf = parsed.asOfDate;
      holdingsSource = holdingsCsvProvenanceUrl(ticker);
      csvTotals = { netAssets: parsed.netAssets, sharesOutstanding: parsed.sharesOutstanding };
      providers.spFunds = true;
    } catch (error) {
      outputNote(`[ ${'holdings'.padEnd(9)}] ${ticker}: official holdings CSV unavailable (${errorMessage(error)}), trying EDGAR`);
      if (config.edgarFallback && edgar) {
        try {
          const fallback = await edgar(ticker, catalogFund.name);
          if (fallback && fallback.rows.length) {
            // N-PORT-P is quarterly and lags: it must never replace fresher published holdings.
            const publishedAsOf = previous.holdings.rows.length ? previous.holdings.asOfDate : null;
            if (publishedAsOf && (!fallback.asOfDate || fallback.asOfDate < publishedAsOf)) {
              outputNote(`[ ${'edgar'.padEnd(9)}] ${ticker}: N-PORT-P as of ${fallback.asOfDate ?? 'unknown'} is older than the published holdings (${publishedAsOf}), ignored`);
            } else {
              holdingsRows = fallback.rows;
              holdingsAsOf = fallback.asOfDate;
              holdingsSource = `${trustForTicker(ticker).name} Form N-PORT-P (EDGAR, CIK ${trustForTicker(ticker).cik})`;
              providers.edgar = true;
            }
          }
        } catch (nportError) {
          outputNote(`[ ${'edgar'.padEnd(9)}] ${ticker}: N-PORT-P fallback failed (${errorMessage(nportError)})`);
        }
      }
      if (!holdingsRows) failedSources.push('holdings');
    }
  }
  if (!holdingsRows || !holdingsRows.length) {
    holdingsRows = previous.holdings.rows;
    holdingsAsOf = previous.holdings.asOfDate;
    holdingsSource = typeof previous.meta?.['source'] === 'object'
      ? String(((previous.meta['source'] as JsonRecord)['holdingsSource'] ?? '') || '') || null
      : null;
    providers.retained.push('holdings');
  }
  holdingsRows = holdingsRows.map(normalizeHoldingsRow);

  // 3) Yahoo Finance daily history + dividends.
  let days: ChartDay[] = [];
  let dividends: Dividend[] = [];
  let yahooExchange: string | null = null;
  let yahooName: string | null = null;
  const publishedDays = previous.history.rows.map(dayFromHistoryRow).filter((day): day is ChartDay => day !== null);
  if (!config.skipYahoo) {
    try {
      const response = await transport(yahooChartUrl(ticker, config.historyRange, now.getTime()), `${ticker} Yahoo chart`, { headers: yahooHeaders() });
      const chart = parseYahooChart(await response.json());
      // A bounded HISTORY_RANGE only refreshes its window: older published days stay.
      days = mergeHistoryDays(chart.days, publishedDays);
      dividends = chart.dividends;
      yahooExchange = chart.exchange;
      yahooName = chart.longName;
      providers.yahoo = true;
    } catch (error) {
      failedSources.push('Yahoo history');
      outputNote(`[ ${'chart'.padEnd(9)}] ${ticker}: Yahoo chart unavailable (${errorMessage(error)}), keeping the published history`);
    }
  }
  if (!days.length) {
    days = publishedDays;
    providers.retained.push('history');
  }

  if (failedSources.length && previous.meta) {
    outputNote(`[ ${'keep'.padEnd(9)}] ${ticker}: ${failedSources.join(' + ')} failed, the fund stays exactly as published`);
    return {
      entry: entryFromMeta(ticker, previous.meta),
      providers: { ...providers, retained: [...new Set([...providers.retained, 'all published files'])] },
      reason: `retained: ${failedSources.join('+')} failed, fund kept as published`,
      written: false,
      status: 'unchanged',
      failedSources,
    };
  }

  const details = page ? detailsFromPage(page, ticker) : null;
  const previousMeta = previous.meta ?? {};
  const previousDetails = previousMeta as JsonRecord;
  const previousReturnsBlock = (previousDetails['returns'] ?? {}) as JsonRecord;
  const previousMonthEnd = (previousReturnsBlock['monthEnd'] ?? emptyReturns()) as OfficialReturnRow;
  const previousQuarterEnd = (previousReturnsBlock['quarterEnd'] ?? previousMonthEnd) as OfficialReturnRow;
  const previousMetrics = (previousDetails['metrics'] ?? {}) as JsonRecord;
  const previousIdentifiers = (previousDetails['identifiers'] ?? {}) as JsonRecord;
  const previousDistributions = (previousDetails['distributions'] ?? {}) as JsonRecord;

  // Section units of the issuer page. A section the page no longer carries keeps the
  // published values as ONE unit (returns travel with their date and basis); a section that is
  // present with an honest blank publishes the blank.
  const hasDetails = Boolean(page && page.details.size > 0);
  const hasPricing = Boolean(page && page.pricing.size > 0);
  const hasReturns = Boolean(page && page.monthEnd);
  const fromPrevious: FundDetails = {
    ticker,
    name: (previousDetails['name'] as string | null) ?? null,
    category: null,
    fundPage: fundPageUrl(ticker),
    inceptionDate: (previousDetails['inceptionDate'] as string | null) ?? null,
    terValue: numberOrNull(previousDetails['terValue']),
    netTerValue: numberOrNull(previousDetails['netTerValue']),
    terGrossValue: numberOrNull(previousDetails['terGrossValue']),
    aumValue: numberOrNull(previousDetails['aumValue']),
    officialReturns: previousMonthEnd,
    cusip: (previousDetails['cusip'] as string | null) ?? null,
    isin: (previousDetails['isin'] as string | null) ?? null,
    indexTicker: (previousIdentifiers['indexTicker'] as string | null) ?? null,
    exchange: (previousDetails['exchange'] as string | null) ?? null,
    navValue: numberOrNull(previousDetails['navValue']),
    navAsOfDate: (previousDetails['asOfDate'] as string | null) ?? null,
    secYield: numberOrNull(previousMetrics['secYield']),
    distributionRate: numberOrNull(previousMetrics['dividendYield']),
    frequency: (previousDistributions['frequency'] as string | null) ?? null,
    midpoint: numberOrNull(previousDetails['midpoint']),
    premiumDiscount: numberOrNull(previousDetails['premiumDiscountValue'] ?? previousDetails['premiumDiscount']),
    closePriceValue: numberOrNull(previousDetails['closePriceValue'] ?? previousDetails['closePrice']),
  };
  const merged: FundDetails = details === null ? fromPrevious : {
    ...fromPrevious,
    name: details.name ?? fromPrevious.name,
    ...(hasDetails ? {
      inceptionDate: details.inceptionDate, terValue: details.terValue, netTerValue: details.netTerValue, terGrossValue: details.terGrossValue,
      cusip: details.cusip, exchange: details.exchange, secYield: details.secYield, indexTicker: details.indexTicker,
    } : {}),
    ...(hasPricing ? {
      aumValue: details.aumValue, navValue: details.navValue, navAsOfDate: details.navAsOfDate, premiumDiscount: details.premiumDiscount,
      midpoint: details.midpoint, closePriceValue: details.closePriceValue,
    } : {}),
    ...(hasReturns ? { officialReturns: details.officialReturns } : {}),
    frequency: details.frequency,
  };

  const closePriceValue = merged.closePriceValue ?? null;

  // The official holdings CSV carries the same NetAssets / SharesOutstanding
  // totals as the Pricing table; use them only when the page did not load.
  const officialNetAssets = parseMoneyNumber(lookupPattern(page?.pricing ?? new Map(), /net assets/i)) ?? csvTotals.netAssets;
  const officialShares = parseMoneyNumber(lookupPattern(page?.pricing ?? new Map(), /shares outstanding/i)) ?? csvTotals.sharesOutstanding;
  const aumRaw = merged.aumValue ?? officialNetAssets;
  const aumValue = aumRaw === null ? null : round(aumRaw, 2);
  const sharesValue = officialShares;
  const midpointValue = merged.midpoint
    ?? (sharesValue !== null && merged.navValue !== null ? round(sharesValue * merged.navValue, 6) : null);
  const name = merged.name ?? yahooName;

  const officialDistributions = page && page.distributions.length ? page.distributions : dividendsFromPublished(previousDistributions['rows']);
  const mergedDividends = mergeDividends(officialDistributions, dividends);
  const officialDistribution = mergedDividends.find((row) => row.amount !== null) ?? null;
  const frequency = merged.frequency
    ?? inferDistributionFrequency(mergedDividends.map((row) => row.exDate))
    ?? (mergedDividends.length ? null : (previousDistributions['frequency'] as string | null) ?? null);
  const metrics = deriveMetrics(
    merged.officialReturns ?? emptyReturns(),
    frequency,
    officialDistribution?.amount ?? null,
    merged.navValue,
    merged.secYield,
  );
  if (!hasReturns && typeof previousMetrics['returnsBasis'] === 'string' && previousMetrics['returnsBasis']) {
    metrics.returnsBasis = previousMetrics['returnsBasis'];
  }
  if (!hasReturns && details !== null) providers.retained.push('returns (table missing on the page)');
  if (!hasPricing && details !== null) providers.retained.push('pricing (table missing on the page)');
  if (!hasDetails && details !== null) providers.retained.push('fund details (table missing on the page)');

  // Data-dependent selection filters run on the freshly published facts; a fund
  // that has nothing published yet always writes once so later runs can filter it.
  const filterReasons = fundFilterReasons({
    ticker,
    aumValue,
    terValue: merged.terValue,
    secYield: merged.secYield,
    dividendYield: metrics.dividendYield,
    returns: merged.officialReturns ?? emptyReturns(),
    metrics,
  }, config);
  if (filterReasons.length && previous.meta) {
    return {
      entry: entryFromMeta(ticker, previous.meta),
      providers: { ...providers, retained: [...providers.retained, 'all published files'] },
      reason: `filter: ${filterReasons.join('+')}`,
      written: false,
      status: 'skipped',
    };
  }

  // Write order: pages first, then meta.json, then (in runUpdater) the index row; stale pages go last.
  const holdingsManifest = await writePages(
    new URL('holdings/', dir), ticker, 'holdings', [...HOLDINGS_HEADERS], holdingsRows, config.holdingsPageSize, holdingsAsOf, false,
  );
  const newestDay = days.reduce<string | null>((max, day) => (max === null || day.date > max ? day.date : max), null);
  const historyManifest = await writePages(
    new URL('history/', dir), ticker, 'history', [...HISTORY_HEADERS], historyRowsFromDays(days), config.historyPageSize, newestDay, false,
  );

  const trust = trustForTicker(ticker);
  const meta: JsonRecord = {
    ticker,
    name,
    category: null,
    fundPage: fundPageUrl(ticker),
    dataFile: `funds/${ticker}/meta.json`,
    ter: merged.terValue === null ? '—' : `${merged.terValue.toFixed(2)}%`,
    terValue: merged.terValue,
    terGross: merged.terGrossValue == null ? '—' : `${merged.terGrossValue.toFixed(2)}%`,
    terGrossValue: merged.terGrossValue ?? null,
    nav: merged.navValue === null ? '—' : `$${merged.navValue.toFixed(2)}`,
    navValue: merged.navValue,
    aum: aumValue === null ? '—' : formatAumDisplay(aumValue),
    aumValue,
    asOfDate: merged.navAsOfDate,
    inceptionDate: merged.inceptionDate,
    exchange: merged.exchange ?? yahooExchange,
    closePrice: closePriceValue === null ? '—' : `$${closePriceValue.toFixed(2)}`,
    closePriceValue,
    closePriceAsOfDate: merged.navAsOfDate,
    premiumDiscount: merged.premiumDiscount === null ? '—' : `${merged.premiumDiscount.toFixed(2)}%`,
    premiumDiscountValue: merged.premiumDiscount,
    sharesOutstanding: sharesValue,
    midpoint: midpointValue,
    cusip: merged.cusip,
    isin: merged.isin,
    distributions: publishDistributions(mergedDividends, frequency, officialDistribution, previousMeta),
    returns: {
      monthEnd: hasReturns ? page!.monthEnd!.returns : previousMonthEnd,
      quarterEnd: hasReturns ? (page!.quarterEnd?.returns ?? page!.monthEnd!.returns) : previousQuarterEnd,
    },
    metrics,
    holdings: holdingsManifest,
    history: historyManifest,
    generatedAt: isoStamp(now),
    netTerValue: merged.netTerValue ?? merged.terValue,
    source: {
      provider: 'SP Funds (Sharia-compliant ETFs)',
      site: `${SPFUNDS_SITE}/`,
      catalog: SPFUNDS_LINEUP_URL,
      details: fundPageUrl(ticker),
      holdingsSource: holdingsSource ?? holdingsCsvProvenanceUrl(ticker),
      historySource: `${yahooChartProvenanceUrl(ticker)} (daily market price history)`,
      distributionsSource: page && page.distributions.length ? `${fundPageUrl(ticker)} Distribution Details table` : yahooChartProvenanceUrl(ticker),
      yahoo: yahooChartProvenanceUrl(ticker),
      trust: trust.name,
      trustCik: trust.cik,
    },
    identifiers: {
      cusip: merged.cusip,
      isin: merged.isin,
      // The performance table's first non-fund row is the fund's declared index:
      // indexTicker keeps the provider nickname (SPSIEUT, ...) and benchmark the
      // index's own published name.
      indexTicker: merged.indexTicker ?? (hasReturns ? page!.benchmark : (previousIdentifiers['indexTicker'] as string | null)) ?? null,
      benchmark: hasReturns ? (page!.benchmarkName ?? null) : ((previousIdentifiers['benchmark'] as string | null) ?? null),
    },
    yields: {
      dividendYield: metrics.dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind: metrics.dividendYield === null
        ? null
        : 'derived: latest official distribution x inferred payments per year / official NAV',
      distributionRate: metrics.dividendYield,
      secYield: metrics.secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind: metrics.secYield === null ? null : 'official SP Funds 30-day SEC yield (fund page Fund Details)',
    },
    documents: page && Object.keys(page.documents).length ? page.documents : ((previousMeta['documents'] as JsonRecord | undefined) ?? {}),
    performance: hasReturns
      ? { benchmark: page!.benchmark, benchmarkName: page!.benchmarkName, rows: page!.performanceRows }
      : (previousMeta['performance'] ?? null),
  };
  const written = await writeIfChanged(new URL('meta.json', dir), meta);
  await prunePages(new URL('holdings/', dir), holdingsManifest);
  await prunePages(new URL('history/', dir), historyManifest);
  const reason = providers.retained.length ? `retained: ${[...new Set(providers.retained)].join(', ')}` : undefined;
  return { entry: entryFromMeta(ticker, meta), providers, reason, written, status: written ? 'updated' : 'unchanged' };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function buildCatalogIndex(brand: string, funds: CatalogFund[], holdings: number, history: number, generatedAt: string): JsonRecord {
  return {
    generatedAt,
    provider: 'SP Funds',
    source: {
      catalog: SPFUNDS_LINEUP_URL,
      catalogSource: `${SPFUNDS_LINEUP_URL} (Sharia-compliant ETF lineup)` ,
      sitemap: `${SPFUNDS_SITE}/wp-sitemap.xml`,
      site: `${SPFUNDS_SITE}/`,
      trust: TIDAL_TRUST.name,
      trustCik: TIDAL_TRUST.cik,
      nportTrust: `${TIDAL_TRUST.name} / ${SPFUNDS_TRUST.name}`,
      nportTrustCik: `${TIDAL_TRUST.cik} / ${SPFUNDS_TRUST.cik}`,
    },
    counts: { funds: funds.length, holdings, history },
    funds,
  };
}

export function catalogIndexEntry(outcome: FundOutcome): JsonRecord {
  return outcome.entry;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export type RunSummary = {
  brand: string;
  generatedAt: string;
  funds: number;
  holdings: number;
  history: number;
  written: number;
  failures: string[];
  skipped: string[];
  /** Funds kept as published because a required source failed. */
  degraded: string[];
  newFunds: string[];
  deadlineHit: boolean;
};

/** The run stops taking new funds after this long (the workflow timeout is 30 minutes) and still writes the index. */
export const SOFT_DEADLINE_MS = 25 * 60 * 1000;

export async function runUpdater(
  config: UpdaterConfig,
  options: {
    apiRoot?: URL;
    fetcher?: Fetcher;
    now?: Date;
    catalogHtml?: string;
    transport?: Transport;
    summary?: (summary: RunSummary) => Promise<void> | void;
    deadlineMs?: number;
    clock?: () => number;
  } = {},
): Promise<RunSummary> {
  const apiRoot = options.apiRoot ?? API_ROOT;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  const generatedAt = isoStamp(now);
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineMs = options.deadlineMs ?? SOFT_DEADLINE_MS;
  const gate = createRequestGate(config.concurrency, config.requestSleep * 1000);
  const transport = options.transport ?? createTransport(config, gate, fetcher);
  const edgar = config.edgarFallback ? createEdgarFallback(config, transport) : null;
  await mkdir(apiRoot, { recursive: true });

  outputPrintConfig('SP Funds', config as unknown as JsonRecord);

  // 1) Catalog tickers: the official "Our ETFs" lineup, unioned with everything
  //    already published so a bounded or filtered run never shrinks the feed.
  let catalogHtml: string | undefined = options.catalogHtml;
  if (catalogHtml === undefined && !config.skipSpFunds) {
    try {
      const response = await transport(SPFUNDS_LINEUP_URL, 'lineup homepage', { headers: browserHeaders() });
      catalogHtml = await response.text();
    } catch (error) {
      outputNote(`[ ${'catalog'.padEnd(9)}] homepage unavailable (${errorMessage(error)}), using the known SP Funds tickers`);
      catalogHtml = '';
    }
  }
  const previousIndex = await readPreviousIndex(apiRoot);
  const catalog = new Map<string, CatalogFund>();
  for (const fund of buildCatalog(catalogHtml ?? '', config.tickers)) catalog.set(fund.ticker, fund);
  for (const [ticker, entry] of previousIndex) {
    if (!catalog.has(ticker)) catalog.set(ticker, catalogFromPrevious(ticker, entry));
  }
  if (!catalog.size) throw new Error('catalog: no SP Funds ETFs selected');
  const unknown = config.tickers.filter((ticker) => !catalog.has(ticker));
  if (unknown.length) throw new Error(`catalog: requested tickers absent from the lineup: ${unknown.join(', ')}`);
  const newFunds = previousIndex.size ? [...catalog.keys()].filter((ticker) => !previousIndex.has(ticker)).sort() : [];
  if (newFunds.length) console.log(`NEW FUNDS: ${newFunds.join(', ')}`);
  const universe = [...catalog.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const filtered = universe.filter((fund) => !config.tickers.length || config.tickers.includes(fund.ticker));
  const deferred = Boolean(
    config.aumRange || config.terRange || config.dividendYieldRange || config.secYieldRange
    || Object.keys(config.performanceRanges).length || Object.keys(config.totalReturnRanges).length,
  );
  outputPrintFilter(filtered.length, universe.length);
  if (deferred) console.log(`[ ${'filter'.padEnd(9)}] range filters are evaluated per fund against freshly parsed facts`);

  // 2) Bounded batches resume from a cursor that is only valid for the same scope.
  const scope = stableContentKey({
    tickers: [...config.tickers].sort(), aum: config.aumRange ?? null, ter: config.terRange ?? null,
    dividend: config.dividendYieldRange ?? null, sec: config.secYieldRange ?? null,
    performance: config.performanceRanges, totalReturn: config.totalReturnRanges,
  });
  const cursor = config.maxFetches > 0 ? await readCursor(apiRoot, scope) : null;
  const batch = batchSelection(filtered, config.maxFetches, cursor);
  if (config.maxFetches > 0) console.log(`[ ${'cursor'.padEnd(9)}] ${batch.length} selected for this batch; after ${cursor ?? 'start'}`);
  const queue = [...batch];

  const rows = new Map<string, JsonRecord>(previousIndex);
  for (const fund of universe) {
    if (!rows.has(fund.ticker)) rows.set(fund.ticker, placeholderEntry(fund.ticker, fund.fundPage));
  }

  const reporter = outputCreateReporter(batch.length);
  const summary: RunSummary = { brand: 'SP Funds', generatedAt, funds: batch.length, holdings: 0, history: 0, written: 0, failures: [], skipped: [], degraded: [], newFunds, deadlineHit: false };
  const outcomes: Array<{ ticker: string; status: string; reason?: string }> = [];
  const workers = new Array(Math.max(1, Math.min(config.concurrency, queue.length))).fill(null).map(async () => {
    for (;;) {
      if (clock() - startedAt > deadlineMs && queue.length) {
        summary.deadlineHit = true;
        outputNote(`[ ${'deadline'.padEnd(9)}] soft deadline reached, ${queue.length} fund(s) left for the next run`);
        queue.length = 0;
      }
      const fund = queue.shift();
      if (!fund) return;
      const before = await fundDigest(apiRoot, fund.ticker);
      try {
        const outcome = await updateFund(fund, config, apiRoot, transport, edgar, now);
        const changed = (await fundDigest(apiRoot, fund.ticker)) !== before;
        rows.set(fund.ticker, outcome.entry);
        if (outcome.failedSources?.length) summary.degraded.push(fund.ticker);
        outcomes.push({ ticker: fund.ticker, status: outcome.status === 'updated' && !changed ? 'unchanged' : outcome.status, reason: outcome.reason });
        summary.written += changed ? 1 : 0;
        reporter.result(fund.ticker, outcome.status === 'updated' && !changed ? 'unchanged' : outcome.status, {
          history: outcome.entry['history'],
          holdings: outcome.entry['holdings'],
          distributions: (outcome.entry['distributions'] as JsonRecord | undefined)?.['frequency'],
          netAssets: outcome.entry['aumValue'],
          yields: outcome.entry['metrics'],
        }, outcome.reason);
      } catch (error) {
        outputNote(`[ ${'error'.padEnd(9)}] ${fund.ticker}: ${errorMessage(error)}`);
        outcomes.push({ ticker: fund.ticker, status: 'failed', reason: errorMessage(error) });
        summary.failures.push(fund.ticker);
        reporter.result(fund.ticker, 'failed', {}, errorMessage(error));
      }
    }
  });
  await Promise.all(workers);

  // 3) Publish the catalog: every fund keeps its row, processed funds get fresh facts.
  const funds = [...rows.values()].sort((a, b) => String(a['ticker']).localeCompare(String(b['ticker'])));
  const holdingsTotal = funds.reduce((sum, row) => sum + (numberOrNull(row['holdings']) ?? 0), 0);
  const historyTotal = funds.reduce((sum, row) => sum + (numberOrNull(row['history']) ?? 0), 0);
  const index = buildCatalogIndex('SP Funds', [], holdingsTotal, historyTotal, generatedAt);
  index['funds'] = funds;
  index['counts'] = { funds: funds.length, holdings: holdingsTotal, history: historyTotal };
  const indexWritten = await writeIfChanged(new URL('index.json', apiRoot), index);
  summary.holdings = holdingsTotal;
  summary.history = historyTotal;
  summary.written += indexWritten ? 1 : 0;

  // 4) Progress: only a clean bounded batch advances the cursor, a full pass clears it.
  let progressWritten = false;
  if (!summary.failures.length && !summary.deadlineHit) {
    if (config.maxFetches > 0 && batch.length) progressWritten = await writeIfChanged(new URL(STATE_FILE, apiRoot), { scope, cursor: batch[batch.length - 1].ticker });
    else if (config.maxFetches === 0) progressWritten = await clearCursor(apiRoot);
  }

  const failures = summary.failures.length;
  const updated = outcomes.filter((outcome) => outcome.status === 'updated').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  summary.skipped = outcomes.filter((outcome) => outcome.status === 'skipped').map((outcome) => outcome.ticker);
  console.log(`[ ${'done'.padEnd(9)}] ${updated} funds updated, ${failures} failures`);
  console.log(`[ ${'done'.padEnd(9)}] counts: funds=${funds.length} holdings=${formatCount(holdingsTotal)} history=${formatCount(historyTotal)}; processed=${outcomes.length} skipped=${skipped}${progressWritten ? '' : ''}`);
  if (failures) console.log(`[ ${'failed'.padEnd(9)}] ${summary.failures.join(', ')}`);
  await outputWriteSummary([
    `### SP Funds data update`,
    ``,
    `- Funds processed: ${outcomes.length} (updated ${updated}, skipped ${skipped}, failed ${failures})`,
    `- Catalog: ${funds.length} funds, ${formatCount(holdingsTotal)} holdings rows, ${formatCount(historyTotal)} history rows`,
    `- Files written: ${formatCount(summary.written)}`,
    `- Ticker cursor: ${config.maxFetches > 0 ? (batch[batch.length - 1]?.ticker ?? '(none)') : '(full pass)'}`,
    failures ? `- Failures: ${summary.failures.join(', ')}` : `- Failures: none`,
    ...(summary.degraded.length ? [`- Kept as published (a source failed): ${summary.degraded.join(', ')}`] : []),
    ...(newFunds.length ? [`- NEW FUNDS: ${newFunds.join(', ')}`] : []),
    ...(summary.deadlineHit ? [`- Soft deadline reached: remaining funds were left for the next run`] : []),
  ]);
  if (options.summary) await options.summary(summary);
  return summary;
}

/** A previously published fund that the live catalog no longer advertises. */
export function catalogFromPrevious(ticker: string, entry: JsonRecord): CatalogFund {
  return {
    ticker,
    name: (entry['name'] as string | null) ?? null,
    category: (entry['category'] as string | null) ?? null,
    fundPage: (entry['fundPage'] as string | null) ?? fundPageUrl(ticker),
    inceptionDate: (entry['inceptionDate'] as string | null) ?? null,
    terValue: numberOrNull(entry['terValue']),
    netTerValue: numberOrNull(entry['terValue']),
    aumValue: numberOrNull(entry['aumValue']),
    officialReturns: emptyReturns(),
  };
}

/** Bounded-run progress marker; only valid for the same selection scope. */
export async function readCursor(apiRoot: URL, scope: string | null = null): Promise<string | null> {
  try {
    const payload = JSON.parse(await readFile(new URL(STATE_FILE, apiRoot), 'utf8')) as JsonRecord;
    if (scope !== null && payload['scope'] !== scope) return null;
    return sanitizeTicker(payload['cursor'] ?? '') || null;
  } catch {
    return null;
  }
}

export async function writeCursor(apiRoot: URL, cursor: string | null, scope: string | null = null): Promise<void> {
  await writeIfChanged(new URL(STATE_FILE, apiRoot), { scope, cursor: cursor ?? null });
}

/** A full pass republishes every fund, so the cursor file is removed. */
export async function clearCursor(apiRoot: URL): Promise<boolean> {
  const file = new URL(STATE_FILE, apiRoot);
  try {
    await readFile(file);
  } catch {
    return false;
  }
  await rm(file, { force: true });
  return true;
}

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE.trim());
    return 0;
  }
  if (argv.length) throw new Error(`unsupported argument(s): ${argv.join(' ')}. Use --help for usage.`);
  const controls = await runtimeControls(env);
  installSystemCa(parseSystemCaMode(controls));
  if (controls['VERBOSE'] !== undefined && env === process.env) process.env['VERBOSE'] = controls['VERBOSE'];
  const summary = await runUpdater(readConfig(controls));
  // Non-zero when a fund threw, or when every processed fund had to be kept because its sources failed.
  const everyFundDegraded = summary.funds > 0 && summary.degraded.length >= summary.funds;
  return summary.failures.length || everyFundDegraded ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`[ ${'error'.padEnd(9)}] ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
