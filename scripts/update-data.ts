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

// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type ParsedChart = {
  days: ChartDay[];
  dividends: Dividend[];
  exchange: string | null;
  firstTradeDate: string | null;
  longName: string | null;
};

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
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

/** `10/01/2026`, `2026-10-01`, `Oct 1 2026` -> `2026-10-01`; null when unparseable. Pure calendar text (shared calendar-dates block), the same day in every time zone. */
export function toIsoDate(raw: unknown): string | null {
  return calendarIso(cleanText(raw)) ?? null;
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

/** The tickers the live homepage lists (the "Our ETFs" menu, else the cards), null when it lists none (not read, or redesigned). */
export function liveLineup(html: string): string[] | null {
  const menu = parseCatalogMenu(html);
  const tickers = (menu.length ? menu : parseCatalogCards(html)).map((entry) => entry.ticker);
  return tickers.length ? tickers : null;
}

/**
 * The whole live lineup as catalog funds; the known SP Funds ETFs when the homepage lists none. A TICKERS selection never
 * adds a fund here: an entry outside the lineup and the published feed is an error (assertKnownTickers, open-items etfs Q27).
 */
export function buildCatalog(html: string): CatalogFund[] {
  const menu = parseCatalogMenu(html);
  const cards = parseCatalogCards(html);
  const byTicker = new Map<string, CatalogFund>();
  const add = (entry: CatalogCard, name: string | null): void => {
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
  if (!byTicker.size) {
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
    for (const [header, key] of Object.entries(slotToKey)) returns[key] = numberOrNull(row[indexOf(header)]);
    returns.sinceInception = numberOrNull(row[indexOf('Since Inception (Annualized)')]);
    const tickerRow = cleanText(row[1] ?? '');
    const fundName = cleanText(row[0] ?? '') || null;
    // A tenor longer than the fund's age at the table date is not published as a number (shared "younger than" rule):
    // the site prints 0.00% for it, which must never become a real zero return.
    return { tickerRow, fundName, returns: withoutYoungReturns(returns, inception, returns.asOfDate, { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 }) };
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
      adjCloseRaw: adjusted ?? close ?? 0,
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

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;

/**
 * A shorter HISTORY_RANGE window must not erase what is already published: fresh days win
 * inside the window, published days older than the window are kept.
 */
export function mergeHistoryDays(fresh: ChartDay[], published: ChartDay[]): ChartDay[] {
  if (!fresh.length) return published;
  const oldest = fresh.reduce((min, day) => (day.date < min ? day.date : min), fresh[0].date);
  const publishedAdj = new Map(published.map((day) => [day.date, day.adjClose]));
  const merged = fresh.map((day) => {
    const prior = publishedAdj.get(day.date);
    const raw = day.adjCloseRaw ?? day.adjClose;
    return prior !== undefined && prior !== day.adjClose && Math.abs(raw - prior) <= 0.005 + ADJ_CLOSE_NOISE ? { ...day, adjClose: prior } : day;
  });
  return [...merged, ...published.filter((day) => day.date < oldest)];
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
// SEC EDGAR Form N-PORT-P (holdings fallback): the shared nport-reader block at the end of this file finds, reads and checks
// the filing (the fund's own series, newest report period first, strictly newer than the published holdings)
// ---------------------------------------------------------------------------

export type NportFallbackResult = { rows: SheetRow[]; asOfDate: string | null; source: string; accession: string };
/** The published holdings an N-PORT report must be strictly newer than: ISO as-of date and row count. */
export type NportPublished = { asOf: string | null; rows: number };
export type EdgarFallback = (ticker: string, name: string | null, published: NportPublished) => Promise<NportFallbackResult | null>;

/**
 * The SP Funds holdings sheet of an N-PORT filing (HOLDINGS_HEADERS), heaviest weight first. A missing number stays empty
 * (never 0), a missing text is '—'; identifiers are the position's own, tickers come from nportTickers (U.S. equities only).
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): SheetRow[] {
  const rows: SheetRow[] = filing.positions.map((position, index) => ({
    Name: position.name || '—',
    Ticker: tickers[index] || '—',
    Identifier: nportIdentifier(position) || '—',
    Weight: nportCell(position.weight),
    'Market Value': nportCell(position.value, 2),
    'Shares Held': nportCell(position.balance),
    'Asset Category': position.assetCat || '—',
  }));
  const weight = (row: SheetRow): number => numberOrNull(row['Weight']) ?? 0;
  return rows.sort((a, b) => weight(b) - weight(a) || a['Identifier'].localeCompare(b['Identifier']) || a['Name'].localeCompare(b['Name']));
}

/**
 * Holdings fallback for one run (runUpdater creates it once per run: this closure is the run's SEC state). The fund is
 * identified by the series id SEC lists for its ticker in company_tickers_mf.json (registrant CIK from the same row, one of
 * the two verified SP Funds trusts); only when SEC lists no series is the fund's name matched in its trust's filings.
 */
export function createEdgarFallback(config: UpdaterConfig, transport: Transport, output: (message: string) => void = outputNote): EdgarFallback {
  const state: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };
  const getText = async (url: string, label: string): Promise<string> => (await transport(url, label, { headers: secHeaders(config) })).text();
  const getJson = async (url: string, label: string): Promise<unknown> => (await transport(url, label, { headers: secHeaders(config) })).json();
  // Each SEC table is loaded once per run; a failed load is asked again by the next fund.
  const fundTable = (): Promise<Map<string, NportSeriesRef>> => {
    if (!state.funds) {
      const loading = getJson(SEC_FUND_TICKERS_URL, 'fund ticker table').then((payload) => parseSecFundTickers(payload));
      state.funds = loading;
      loading.catch(() => { if (state.funds === loading) state.funds = null; });
    }
    return state.funds;
  };
  const companyNames = (): Promise<Map<string, string>> => {
    if (!state.names) {
      const loading = getJson(SEC_COMPANY_TICKERS_URL, 'company ticker table').then((payload) => parseSecCompanyNames(payload));
      state.names = loading;
      loading.catch(() => { if (state.names === loading) state.names = null; });
    }
    return state.names;
  };

  return async (ticker: string, name: string | null, published: NportPublished): Promise<NportFallbackResult | null> => {
    let ref: NportSeriesRef | null = null;
    try {
      ref = (await fundTable()).get(sanitizeTicker(ticker)) ?? null;
    } catch (error) {
      output(`[ ${'edgar'.padEnd(9)}] fund ticker table: ${errorMessage(error)}`);
    }
    // The registrants are verified: never silently publish another trust's filing.
    if (ref && ![TIDAL_TRUST.cik, SPFUNDS_TRUST.cik].some((cik) => Number(cik) === Number(ref!.cik))) {
      output(`[ ${'edgar'.padEnd(9)}] ${ticker}: SEC lists registrant CIK ${ref.cik}, not an SP Funds trust`);
      return null;
    }
    const fund = ref ? { ticker, cik: ref.cik, seriesId: ref.seriesId } : { ticker, cik: trustForTicker(ticker).cik, name };
    const read = await readNportHoldings(fund, published, getText, { cache: state.reader });
    if ('problem' in read) {
      output(`[ ${'nport'.padEnd(9)}] ${read.problem}`);
      return null;
    }
    if (read.loose) output(`[ ${'nport'.padEnd(9)}] ${ticker}: series "${read.filing.seriesName}" matched the fund name loosely`);
    const names = await companyNames().catch((error: unknown) => { output(`[ ${'edgar'.padEnd(9)}] company ticker table: ${errorMessage(error)}`); return null; });
    return {
      rows: nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, names)),
      asOfDate: read.filing.repPdDate || null,
      source: read.url,
      accession: read.candidate.accession,
    };
  };
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
  /** Which definition stands behind dividendYield; null exactly when dividendYield is null. */
  dividendYieldBasis: YieldBasis | null;
  secYield: number | null;
  secYieldText: string;
  returnsBasis: string;
  performanceAsOf: string | null;
};

export type YieldBasis = 'official-trailing-12m' | 'official-distribution-rate' | 'official-other' | 'computed-trailing-12m' | 'indicated';

/**
 * SP Funds publishes no distribution yield, so every non-null dividendYield is
 * the updater's own estimate (latest distribution x inferred payments per year / NAV).
 */
export function dividendYieldBasisFor(dividendYield: number | null): YieldBasis | null {
  return dividendYield === null ? null : 'indicated';
}

/** Metrics from a published meta/index: the basis code always follows the yield it describes (legacy rows get it derived). */
export function metricsWithYieldBasis(metrics: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(metrics)) {
    out[key] = value;
    if (key === 'dividendYieldText' && !('dividendYieldBasis' in metrics)) out['dividendYieldBasis'] = null;
  }
  out['dividendYieldBasis'] = dividendYieldBasisFor(numberOrNull(metrics['dividendYield']));
  return out;
}

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
    dividendYieldBasis: dividendYieldBasisFor(dividendYield),
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
  const manifest: PageManifest = { pages: pages.map((page) => `${kind}/${page.name}`), pageSize, totalRows: rows.length, asOfDate };
  // updateFund passes prune=false and prunes only AFTER the new meta.json is written.
  if (prune) await prunePages(dir, manifest);
  return manifest;
}

/** Remove page files beyond the freshly written count so a shrinking fund leaves no orphans. */
export async function prunePages(dir: URL, manifest: PageManifest): Promise<void> {
  const expected = new Set(manifest.pages.map((page) => page.slice(page.lastIndexOf('/') + 1)));
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
      const value = entry.metrics ? entry.metrics[totalReturnKey(period)] : null;
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

/** Key of the derived total return of a period in `metrics` (the official returns use periodKey: yr1 vs tr1y). */
export function totalReturnKey(period: ReturnPeriod): 'ytd' | 'tr1y' | 'tr3y' | 'tr5y' | 'tr10y' {
  if (period === 'YTD') return 'ytd';
  if (period === '1Y') return 'tr1y';
  if (period === '3Y') return 'tr3y';
  if (period === '5Y') return 'tr5y';
  return 'tr10y';
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

export function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}

export function outputPrintConfig(brand: string, config: JsonRecord, env: Record<string, string | undefined> = process.env): void {
  const entries: Array<[string, string]> = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose(env))]];
  console.log(`[ config   ] ${brand} updater:\n${entries
    .map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`)
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
const OUTPUT_UNITS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };

export function outputMoney(value: unknown): string {
  const numeric = value && typeof value === 'object' ? (value as JsonRecord)['value'] : undefined;
  const raw = typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = /^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i.exec(text);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (OUTPUT_UNITS[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}

/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
export function outputPercent(value: unknown): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
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
    field('div', outputPercent(data['dividendYield'] ?? yields['dividendYield'] ?? metrics['dividendYield'])),
    field('sec', outputPercent(data['secYield'] ?? yields['secYield'] ?? metrics['secYield'])),
  ].filter((part) => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}

export function outputCreateReporter(total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    result(ticker: string, status: string, data: JsonRecord = {}, reason?: unknown): void {
      tally.set(status, (tally.get(status) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, status, data, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number, now: number = Date.now()): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter((status) => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map((status) => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((now - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}

/** Second [ done ] line: published totals. */
export function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
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
    dividendYield: null, dividendYieldText: '—', dividendYieldBasis: null, secYield: null, secYieldText: '—',
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
    metrics: meta['metrics'] ? metricsWithYieldBasis(meta['metrics'] as JsonRecord) : { ...emptyMetrics() },
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

/** The published distribution rows of a meta.json ([Ex-Date, Record Date, Payable Date, Amount] text cells), [] when none. */
export function publishedDistributionRows(meta: JsonRecord | null): string[][] {
  const rows = ((meta?.['distributions'] ?? {}) as JsonRecord)['rows'];
  return Array.isArray(rows) ? rows.filter(Array.isArray).map((row: unknown[]) => row.map((cell) => String(cell ?? ''))) : [];
}

/** A dividend the HISTORY_RANGE window kept from the published rows carries only epoch and amount: give it its ex-date. */
export function dividendFromWindow(dividend: Dividend): Dividend {
  return dividend.exDate ? dividend : { epoch: dividend.epoch, amount: dividend.amount, exDate: epochToIsoDate(dividend.epoch), recordDate: null, payDate: null };
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
  edgar: EdgarFallback | null,
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
  let holdingsFresh = false; // false while holdingsRows are the published pages re-read
  let csvTotals: { netAssets: number | null; sharesOutstanding: number | null } = { netAssets: null, sharesOutstanding: null };
  if (!config.skipSpFunds) {
    try {
      const response = await transport(holdingsCsvUrl(ticker), `${ticker} holdings CSV`, { headers: browserHeaders() });
      const parsed = parseSpFundsHoldingsCsv(await response.text());
      if (parsed.rows.length === 0) throw new Error('holdings CSV contained no positions');
      holdingsRows = parsed.rows;
      holdingsAsOf = parsed.asOfDate;
      holdingsSource = holdingsCsvProvenanceUrl(ticker);
      holdingsFresh = true;
      csvTotals = { netAssets: parsed.netAssets, sharesOutstanding: parsed.sharesOutstanding };
      providers.spFunds = true;
    } catch (error) {
      outputNote(`[ ${'holdings'.padEnd(9)}] ${ticker}: official holdings CSV unavailable (${errorMessage(error)}), trying EDGAR`);
      if (config.edgarFallback && edgar) {
        try {
          // N-PORT-P is quarterly and lags: the reader takes the fund's own newest filing only when its report period is strictly
          // newer than the published holdings (the issuer CSV's as-of day, or the report period of an earlier N-PORT sheet).
          const published = { asOf: calendarIso(previous.holdings.asOfDate), rows: previous.holdings.rows.length };
          const fallback = await edgar(ticker, catalogFund.name ?? ((previous.meta?.['name'] as string | null | undefined) ?? null), published);
          if (fallback && fallback.rows.length) {
            holdingsRows = fallback.rows;
            holdingsAsOf = fallback.asOfDate;
            holdingsSource = `${trustForTicker(ticker).name} Form N-PORT-P (EDGAR accession ${fallback.accession}, report period ${fallback.asOfDate ?? 'n/a'})`;
            holdingsFresh = true;
            providers.edgar = true;
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
  // Fresh holdings (official CSV or N-PORT-P, never the published pages re-read) that look broken (no weight column, non-numeric
  // weights, a bad weight sum, half the rows gone) never replace the published ones: the fund fails like any other failure,
  // nothing is written, so a published fund keeps its files and index row and a new fund keeps its catalog-only row.
  // No relax lets an all-blank weight sheet replace published numeric weights (5th argument, Q24).
  const publishedWeights = holdingsFresh ? holdingsWeightCount(previous.holdings.headers.length ? previous.holdings.headers : HOLDINGS_HEADERS, previous.holdings.rows) : null;
  const holdingsProblem = holdingsFresh
    ? holdingsGuard([...HOLDINGS_HEADERS], holdingsRows, numberOrNull((previous.meta?.['holdings'] as JsonRecord | undefined)?.['totalRows']), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights)
    : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${previous.meta ? 'the fund stays exactly as published' : 'no data published for this fund yet'}`);

  // 3) Yahoo Finance daily history + dividends.
  let days: ChartDay[] = [];
  let dividends: Dividend[] = [];
  let yahooExchange: string | null = null;
  let yahooName: string | null = null;
  const publishedDays = previous.history.rows.map(dayFromHistoryRow).filter((day): day is ChartDay => day !== null);
  if (!config.skipYahoo) {
    try {
      const response = await transport(yahooChartUrl(ticker, config.historyRange, now.getTime()), `${ticker} Yahoo chart`, { headers: yahooHeaders() });
      const fetched = parseYahooChart(await response.json());
      // A HISTORY_RANGE window never shrinks the published history (shared windowed-chart block): the published days older than
      // the window go in front, Adj Close rescaled by the overlapping days; a window that does not join keeps the fund as published.
      // The published distribution rows are [Ex-Date, Record Date, Payable Date, Amount]: the block reads [date, amount].
      const chart = /^\d+y$/.test(config.historyRange)
        ? mergeWindowedChart({ ...fetched, days: [...fetched.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) }, previous.history.rows,
          publishedDistributionRows(previous.meta).map((cells) => [cells[0], cells[3]]))
        : fetched;
      if (!chart) throw new Error(`chart window does not join the published history (${config.historyRange})`);
      // The cent noise of Yahoo's float32 adjusted close keeps the published cent (ADJ_CLOSE_NOISE)
      days = mergeHistoryDays(chart.days, publishedDays);
      dividends = chart.dividends.map((dividend) => dividendFromWindow(dividend));
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
  // A new fund that no source answered (issuer page down, skipped or a block page; no holdings CSV or N-PORT-P; Yahoo down
  // or skipped) is never published as an empty meta.json: it fails and keeps its catalog-only index row (dataFile null).
  const pageAnswered = Boolean(page && (page.details.size || page.pricing.size || page.monthEnd || page.distributions.length));
  if (!previous.meta && !pageAnswered && !holdingsFresh && !providers.yahoo) throw new Error('no source answered; no data published for this fund yet');

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
  // The shared "younger than" rule on the final metrics: no horizon the fund is too young for on the performance table date
  // (calendar anniversary of the inception, inclusive), also when the returns or the inception were kept from the published meta.
  const metrics = withoutYoungReturns(deriveMetrics(
    merged.officialReturns ?? emptyReturns(),
    frequency,
    officialDistribution?.amount ?? null,
    merged.navValue,
    merged.secYield,
  ), merged.inceptionDate, (merged.officialReturns ?? emptyReturns()).asOfDate, { tr1y: 1, tr3y: 3, tr5y: 5, tr10y: 10, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 });
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
      dividendYieldBasis: metrics.dividendYieldBasis,
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
  const previousRows = Array.from(previousIndex.values());
  // The live lineup (null when the homepage was not read or lists no fund): a catalog-only row it no longer lists is dropped.
  const live = liveLineup(catalogHtml ?? '');
  const catalog = new Map<string, CatalogFund>();
  for (const fund of buildCatalog(catalogHtml ?? '')) catalog.set(fund.ticker, fund);
  previousIndex.forEach((entry, ticker) => {
    if (!catalog.has(ticker) && (!live || entry['dataFile'])) catalog.set(ticker, catalogFromPrevious(ticker, entry));
  });
  if (!catalog.size) throw new Error('catalog: no SP Funds ETFs selected');
  // Q27: a TICKERS entry outside the live lineup and the published funds stops the run before any fund request (without a
  // live lineup the built-in SP Funds tickers count as known too)
  assertKnownTickers(config.tickers, live ? knownTickers(live, previousRows) : knownTickers(null, previousRows).concat(SPFUNDS_TICKERS), 'the SP Funds lineup or published feed');
  const universe = [...catalog.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[ catalog  ] ${universe.length} SP Funds ETFs (${catalogHtml ? 'spfunds.com lineup' : 'known SP Funds tickers'}${previousIndex.size ? ' + published index' : ''})`);
  // Closed funds leave the run here, before the MAX_FETCHES batch and any request: never fetched, guarded or reported failed.
  const filtered = withoutClosedFunds(universe.filter((fund) => !config.tickers.length || config.tickers.includes(fund.ticker)), (fund) => fund.ticker, CLOSED_FUNDS);
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

  // Filtered, bounded, skipped and failed funds keep their published row; a stale catalog-only row is dropped (Q27).
  const rows = new Map<string, JsonRecord>(withoutStalePlaceholders(previousRows, live).map((row) => [String(row['ticker']), row] as [string, JsonRecord]));
  for (const fund of universe) {
    if (!rows.has(fund.ticker)) rows.set(fund.ticker, placeholderEntry(fund.ticker, fund.fundPage));
  }

  const reporter = outputCreateReporter(batch.length);
  const summary: RunSummary = { brand: 'SP Funds', generatedAt, funds: batch.length, holdings: 0, history: 0, written: 0, failures: [], skipped: [], degraded: [], newFunds: [], deadlineHit: false };
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
  const funds = markClosedFunds(Array.from(rows.values()).sort((a, b) => String(a['ticker']).localeCompare(String(b['ticker']))), CLOSED_FUNDS);
  const holdingsTotal = funds.reduce((sum, row) => sum + (numberOrNull(row['holdings']) ?? 0), 0);
  const historyTotal = funds.reduce((sum, row) => sum + (numberOrNull(row['history']) ?? 0), 0);
  const index = buildCatalogIndex('SP Funds', [], holdingsTotal, historyTotal, generatedAt);
  index['funds'] = funds;
  index['counts'] = { funds: funds.length, holdings: holdingsTotal, history: historyTotal };
  const indexWritten = await writeIfChanged(new URL('index.json', apiRoot), index);
  summary.holdings = holdingsTotal;
  summary.history = historyTotal;
  summary.written += indexWritten ? 1 : 0;
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const report = newFundsReport(previousRows, funds);
  const newFunds = newFundsLines(report);
  summary.newFunds = report.published;
  for (const line of newFunds) console.log(line);

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
  if (failures) console.log(`[ ${'failed'.padEnd(9)}] ${summary.failures.join(', ')}`);
  console.log(reporter.summary(startedAt, clock()));
  console.log(outputCounts(funds.length, holdingsTotal, historyTotal));
  await outputWriteSummary([
    `### SP Funds data update`,
    ``,
    `- Funds processed: ${outcomes.length} (updated ${updated}, skipped ${skipped}, failed ${failures})`,
    `- Catalog: ${funds.length} funds, ${formatCount(holdingsTotal)} holdings rows, ${formatCount(historyTotal)} history rows`,
    `- Files written: ${formatCount(summary.written)}`,
    `- Ticker cursor: ${config.maxFetches > 0 ? (batch[batch.length - 1]?.ticker ?? '(none)') : '(full pass)'}`,
    failures ? `- Failures: ${summary.failures.join(', ')}` : `- Failures: none`,
    ...(summary.degraded.length ? [`- Kept as published (a source failed): ${summary.degraded.join(', ')}`] : []),
    ...(summary.deadlineHit ? [`- Soft deadline reached: remaining funds were left for the next run`] : []),
  ]);
  if (newFunds.length && process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');
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

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, and never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker)
 * traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
