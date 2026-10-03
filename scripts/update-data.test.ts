/// <reference types="bun" />
/**
 * Offline tests for the SP Funds feed updater. Every sample is a small inline
 * excerpt in the shape the real pages and feeds use; no test performs network I/O.
 * Groups (same names in every ETF repo): controls, parsing, metrics, pipeline, network.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_NAMES, HISTORY_HEADERS, HOLDINGS_HEADERS, SEC_UA_DEFAULT, SPFUNDS_TRUST, TIDAL_TRUST, USAGE,
  annualizedFromCumulative, batchSelection, buildCatalog, buildCatalogIndex, yahooHeaders, buildPages,
  catalogIndexEntry, createEdgarFallback, createRequestGate, createTransport, cumulativeFromAnnualized, deriveMetrics,
  performanceAsOf, edgarSeriesFilingsUrl, errorMessage, fillNportTickers, formatAumDisplay, formatMoneyText,
  formatUsDate, fundFilterReasons, fundPageUrl, holdingsCsvUrl, inferDistributionFrequency, lookupPattern,
  matchesNportFund, matchesRange, mergeDividends, nameValueMap, normalizeWeightText, nportUrlFor, parseMoneyNumber,
  numberOrNull, outputPrintConfig, pageFileName, parseAumRange, parseCatalogCards, parseCatalogMenu,
  parseCompanyTickerMap, parseCsv, parseEdgarAtomFilings, parseFundPage, parseFundTickerMap, parseHtmlTables,
  parseNport, parseNportAccessions, parseRange, parseSpFundsHoldingsCsv, parseYahooChart, paymentsPerYear, periodKey,
  readConfig, readCursor, readPreviousIndex, readPreviousPages, resolveControls, round, runUpdater, runtimeControls,
  samePublishedContent, sanitizeTicker, secHeaders, selectionEntryFromIndex, splitPages, spFundsAssetCategory,
  stableStringify, toIsoDate, trustForTicker, installSystemCa, isCertError, updateFund, writeIfChanged, writePages,
  writeCursor, yahooChartUrl, dayFromHistoryRow, emptyMetrics, formatSheetDate, historyRowsFromDays, isoStamp,
  mergeHistoryDays, placeholderEntry, tenorAvailable, type CatalogFund, type FundOutcome, type JsonRecord,
  type SheetRow, type Transport, type UpdaterConfig
} from './update-data';

// Portable start state: no control variable from the shell or the workflow leaks in, the zone is pinned,
// and fetch, process.exitCode and the temp dirs are restored after every test.
const savedEnv = new Map<string, string | undefined>();
const savedFetch = globalThis.fetch;
const tempDirs: string[] = [];
beforeEach(() => {
  for (const name of [...CONTROL_NAMES, 'GITHUB_STEP_SUMMARY', 'VERBOSE', 'TZ', 'SKIP_SP_FUNDS']) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env['TZ'] = 'UTC';
});
afterEach(async () => {
  for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  globalThis.fetch = savedFetch;
  process.exitCode = 0;
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Inline samples
// ---------------------------------------------------------------------------

const TICKERS = ['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO'];
const SPFUNDS = 'https://www.sp-funds.com';

const HOME_HTML = `<html><body>
<li class="menu-item"><a href="#"><span class="ui-menu-item-wrapper">Our ETFs</span></a>
<ul class="sub-menu">
  <li><a href="${SPFUNDS}/spre/"><span>SPRE</span></a></li>
  <li><a href="${SPFUNDS}/spus/"><span>SPUS</span></a></li>
  <li><a href="${SPFUNDS}/spte/"><span>SPTE</span></a></li>
  <li><a href="${SPFUNDS}/spsk/"><span>SPSK</span></a></li>
  <li><a href="${SPFUNDS}/spwo/"><span>SPWO</span></a></li>
</ul></li>
${[['SPUS', '/spus/'], ['SPSK', '/spsk/'], ['SPRE', `${SPFUNDS}/spre/`], ['SPTE', '/spte/'], ['SPWO', '/spwo/']].map(([ticker, href]) => `
<div class="bdt-ep-advanced-icon-box-content">
  <h3 class="bdt-ep-advanced-icon-box-title ep-title-"><span>${ticker}</span></h3>
  <div class="bdt-ep-advanced-icon-box-description"><p>About ${ticker}</p></div>
  <a class="bdt-ep-advanced-icon-box-readmore" href="${href}">See Details</a>
</div>`).join('')}
</body></html>`;

type FundSample = {
  name: string; cusip: string; inception: string; ter: string; secYield: string; aum: string; nav: string; shares: string;
  asOf: string; month: string[]; quarter: string[]; bench: [string, string]; csv: string[][]; days: number; amount: string;
};
// Performance values: 1 Month, 3 Month, 6 Month, YTD, Since Inception (Cumulative), 1 Year, 3 Year, 5 Year, 10 Year, Since Inception (Annualized), Date
// CSV rows: StockTicker, CUSIP, SecurityName, Shares, Price, MarketValue, Weightings
const SAMPLES: Record<string, FundSample> = {
  SPUS: {
    name: 'SP Funds S&P 500 Sharia Industry Exclusions ETF', cusip: '886364801', inception: '12/17/2019', ter: '0.45%', secYield: '0.40%',
    aum: '$3274.89m', nav: '$59.54', shares: '55,000,000', asOf: '09/30/2026', days: 30, amount: '0.0260',
    month: ['1.25', '3.65', '23.94', '17.13', '217.88', '21.21', '25.32', '16.37', '-', '18.57', '09/30/2026'],
    quarter: ['1.25', '3.65', '23.94', '17.13', '217.88', '21.21', '25.32', '16.37', '-', '18.57', '09/30/2026'],
    bench: ['SPSIEUT', 'S&P 500 Shariah Industry Exclusions Index (USD) TR'],
    csv: [
      ['NVDA', '67066G104', 'NVIDIA Corp', '2033474', '228.38', '464404792.12', '14.14%'],
      ['AAPL', '037833100', 'Apple Inc', '1226303', '333.02', '408383425.06', '12.44%'],
      ['MSFT', '594918104', 'Microsoft Corp', '623931', '512.9', '320014209.9', '9.75%'],
      ['GOOGL', '02079K305', 'Alphabet Inc', '491250', '344.08', '169029300.0', '5.15%'],
      ['AVGO', '11135F101', 'Broadcom Inc', '399767', '351.19', '140394172.73', '4.28%'],
      ['MU', '595112103', 'Micron Technology Inc', '94901', '1065.11', '101080004.11', '3.08%'],
    ],
  },
  SPRE: {
    name: 'SP Funds S&P Global REIT Sharia ETF', cusip: '886364108', inception: '12/17/2019', ter: '0.59%', secYield: '2.10%',
    aum: '$198.59m', nav: '$18.96', shares: '10,475,000', asOf: '09/30/2026', days: 20, amount: '0.0500',
    month: ['0.10', '1.10', '4.10', '5.10', '40.10', '6.10', '3.10', '2.10', '-', '4.60', '09/30/2026'],
    quarter: ['0.10', '1.10', '4.10', '5.10', '40.10', '6.10', '3.10', '2.10', '-', '4.60', '09/30/2026'],
    bench: ['SPGRSHT', 'S&P Global REIT Shariah Index'],
    csv: [
      ['WELL', '95040Q104', 'Welltower Inc', '114291', '230.24', '26314359.84', '13.25%'],
      ['GMG AU', 'B03FYZ4', 'Goodman Group', '1376298', '27.18', '26024613.64', '13.10%'],
      ['WY', '962166104', 'Weyerhaeuser Co', '1062383', '19.05', '20238396.15', '10.19%'],
      ['AA AU', 'B0000AA', 'Another Group', '1', '1.0', '1.0', '5.00%'],
      ['Cash&Other', 'Cash&Other', 'Cash & Other', '-4206403', '1.0', '-4206403.0', '-2.12%'],
    ],
  },
  SPSK: {
    name: 'SP Funds Dow Jones Global Sukuk ETF', cusip: '886364207', inception: '12/17/2019', ter: '0.65%', secYield: '4.50%',
    aum: '$40.00m', nav: '$20.10', shares: '2,000,000', asOf: '09/30/2026', days: 25, amount: '0.0700',
    month: ['0.20', '1.20', '2.20', '3.20', '20.20', '4.20', '2.20', '1.20', '-', '2.60', '09/30/2026'],
    quarter: ['0.20', '1.20', '2.20', '3.20', '20.20', '4.20', '2.20', '1.20', '-', '2.60', '09/30/2026'],
    bench: ['DJSUKUK', 'Dow Jones Sukuk Index'],
    csv: [
      ['SUK1', 'S00000001', 'Sukuk One', '100', '100.0', '10000.0', '20.00%'],
      ['SUK2', 'S00000002', 'Sukuk Two', '100', '100.0', '10000.0', '19.00%'],
      ['SUK3', 'S00000003', 'Sukuk Three', '100', '100.0', '10000.0', '18.00%'],
      ['SUK4', 'S00000004', 'Sukuk Four', '100', '100.0', '10000.0', '17.00%'],
    ],
  },
  SPTE: {
    name: 'SP Funds S&P Global Technology ETF', cusip: '886364306', inception: '11/30/2023', ter: '0.55%', secYield: '0.10%',
    aum: '$261.47m', nav: '$49.80', shares: '5,250,000', asOf: '08/31/2026', days: 15, amount: '0.0065',
    month: ['5.69', '-2.24', '26.84', '34.78', '140.05', '51.03', '0.00', '-', '-', '37.44', '08/31/2026'],
    quarter: ['0.63', '41.81', '38.73', '38.73', '147.08', '58.93', '0.00', '-', '-', '41.92', '06/30/2026'],
    bench: ['SPSITUT', 'S&P Global 1200 Shariah Information Technology Index'],
    csv: [
      ['TSM', '874039100', 'Taiwan Semiconductor', '500', '300.0', '150000.0', '10.00%'],
      ['NVDA', '67066G104', 'NVIDIA Corp', '500', '228.38', '114190.0', '9.00%'],
      ['AAPL', '037833100', 'Apple Inc', '500', '333.02', '166510.0', '8.00%'],
      ['MSFT', '594918104', 'Microsoft Corp', '500', '512.9', '256450.0', '7.00%'],
    ],
  },
  SPWO: {
    name: 'SP Funds S&P World (ex-US) ETF', cusip: '886364405', inception: '11/30/2023', ter: '0.60%', secYield: '1.00%',
    aum: '$30.00m', nav: '$31.00', shares: '1,000,000', asOf: '09/30/2026', days: 10, amount: '0.0300',
    month: ['0.30', '1.30', '2.30', '3.30', '30.30', '4.30', '0.00', '-', '-', '9.60', '09/30/2026'],
    quarter: ['0.30', '1.30', '2.30', '3.30', '30.30', '4.30', '0.00', '-', '-', '9.60', '09/30/2026'],
    bench: ['SPWOIDX', 'S&P World ex-US Shariah Index'],
    csv: [
      ['ASML', 'N07059202', 'ASML Holding', '10', '900.0', '9000.0', '6.00%'],
      ['NOVO', 'K72807132', 'Novo Nordisk', '10', '500.0', '5000.0', '5.00%'],
      ['SHEL', '780259305', 'Shell plc', '10', '300.0', '3000.0', '4.00%'],
      ['TM', '892331307', 'Toyota Motor', '10', '200.0', '2000.0', '3.00%'],
    ],
  },
};
const HOLDINGS_TOTAL = TICKERS.reduce((sum, ticker) => sum + SAMPLES[ticker].csv.length, 0);
const HISTORY_TOTAL = TICKERS.reduce((sum, ticker) => sum + SAMPLES[ticker].days, 0);

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;');
const tableHtml = (headers: string[], rows: string[][]): string =>
  `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const PERFORMANCE_HEADERS = ['Fund Name', 'Fund Ticker', '1 Month', '3 Month', '6 Month', 'YTD', 'Since Inception (Cumulative)', '1 Year', '3 Year', '5 Year', '10 Year', 'Since Inception (Annualized)', 'Date'];
const DISTRIBUTION_DATES: Array<[string, string]> = [
  ['09/28/2026', '09/29/2026'], ['08/26/2026', '08/27/2026'], ['07/27/2026', '07/28/2026'],
  ['06/26/2026', '06/29/2026'], ['05/27/2026', '05/28/2026'], ['04/27/2026', '04/28/2026'],
];
const DOCUMENTS: Array<[string, string]> = [
  ['Prospectus', 'spfunds-PRO_032626_web.pdf'], ['Summary Prospectus', 'spus-497k_033026.pdf'],
  ['SAI', 'spfunds-SAI_032626_web.pdf'], ['Factsheet', 'SPUS-Factsheet-2026-Q2.pdf'],
];
const docTile = (label: string, file: string): string => {
  const link = JSON.stringify({ url: `${SPFUNDS}/wp-content/uploads/${file}` }).replace(/\//g, '\\/').replace(/"/g, '&quot;');
  return `<div data-ep-wrapper-link="${link}"><h3 class="bdt-ep-advanced-icon-box-title">${label}</h3></div>`;
};

function fundPageHtml(ticker: string): string {
  const sample = SAMPLES[ticker];
  const performance = (values: string[]): string[][] => [
    [escapeHtml(sample.name), `${ticker} MKT`, ...values],
    [escapeHtml(sample.name), `${ticker} NAV`, ...values],
    [escapeHtml(sample.bench[1]), sample.bench[0], ...values],
  ];
  return `<html><body><h1>${ticker}</h1>
${tableHtml(['Name', 'Value'], [
    ['Fund Inception', sample.inception], ['Ticker', ticker], ['Primary Exchange', 'NYSE'], ['CUSIP', sample.cusip],
    ['Expense Ratio*', sample.ter], ['30 Day SEC Yield* As of 08/31/2026', sample.secYield],
  ])}
${tableHtml(['Name', 'Value'], [
    ['Net Assets', sample.aum], ['NAV', sample.nav], ['Shares Outstanding', sample.shares],
    ['Premium/Discount Percentage', '-0.01%'], ['Closing Price', sample.nav],
  ])}
${tableHtml(['Name'], [[sample.asOf]])}
${tableHtml(PERFORMANCE_HEADERS, performance(sample.month))}
${tableHtml(PERFORMANCE_HEADERS, performance(sample.quarter))}
${tableHtml(['EX Date', 'Record Date', 'Payable Date', 'Fund Total'], DISTRIBUTION_DATES.map(([ex, pay]) => [ex, ex, pay, sample.amount]))}
${tableHtml(['Name'], [['10/01/2026']])}
${DOCUMENTS.map(([label, file]) => docTile(label, ticker === 'SPTE' ? file.replace('PRO_032626_web', '485bpos_022626-PRO-SPTE') : file)).join('\n')}
<a href="${holdingsCsvUrl(ticker)}" download="TidalFG_Holdings_${ticker}.csv">Download holdings</a>
</body></html>`;
}

function holdingsCsv(ticker: string, rows: string[][] = SAMPLES[ticker].csv): string {
  const header = 'Date,Account,StockTicker,CUSIP,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits';
  return [header, ...rows.map(([symbol, cusip, name, shares, price, value, weight]) =>
    `10/01/2026,${ticker},${symbol},${cusip},${name},${shares},${price},${value},${weight},3283824025.0,55150000,2206.0`)].join('\n');
}

function yahooJson(ticker: string): string {
  const count = SAMPLES[ticker].days;
  const timestamps = Array.from({ length: count }, (_, index) => 1_788_000_000 + index * 86_400);
  return JSON.stringify({
    chart: { result: [{
      meta: { fullExchangeName: 'NYSEArca', firstTradeDate: 1_576_679_400, longName: SAMPLES[ticker].name },
      timestamp: timestamps,
      events: { dividends: {
        a: { amount: 0.026, date: timestamps[count - 1] }, b: { amount: 0.02, date: timestamps[Math.max(0, count - 10)] },
      } },
      indicators: {
        quote: [{ close: timestamps.map((_, index) => 59 + index * 0.01), volume: timestamps.map((_, index) => 1000 + index) }],
        adjclose: [{ adjclose: timestamps.map((_, index) => 58.123456 + index * 0.01) }],
      },
    }] },
  });
}

const SERIES_PAYLOAD = {
  fields: ['cik', 'seriesId', 'classId', 'symbol'],
  data: [
    ['1742912', 'S000070027', 'C000220954', 'SPUS'],
    ['1742912', 'S000070034', 'C000220961', 'SPRE'],
    ['1989916', 'S000073501', 'C000232134', 'SPTE'],
  ],
};

const EDGAR_SUBMISSIONS = JSON.stringify({
  cik: '0001742912', name: 'Tidal Trust I',
  filings: { recent: {
    form: ['NPORT-P', '10-K', 'NPORT-P'],
    accessionNumber: ['0002000324-26-004454', '0002000324-26-000001', '0002000324-26-003796'],
    filingDate: ['2026-09-21', '2026-03-01', '2026-08-25'],
    reportDate: ['2026-07-31', '2025-12-31', '2026-06-30'],
  } },
});

const NPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <formData>
    <genInfo>
      <regName>Tidal Trust I</regName>
      <regCik>0001742912</regCik>
      <seriesName>SP Funds S&amp;P 500 Sharia Industry Exclusions ETF</seriesName>
      <seriesId>S000070027</seriesId>
      <repPdDate>2026-07-31</repPdDate>
    </genInfo>
    <fundInfo>
      <netAssets>3283824025</netAssets>
      <invstOrSecs>
        <invstOrSec><name>NVIDIA CORP</name><identifiers><cusip value="67066G104"/></identifiers><pctVal>14.14000000</pctVal><valUSD>464404792.12</valUSD><balance>2033474</balance><assetCat>EC</assetCat></invstOrSec>
        <invstOrSec><name>APPLE INC</name><identifiers><cusip value="037833100"/></identifiers><pctVal>12.44000000</pctVal><valUSD>408383425.06</valUSD><balance>1226303</balance><assetCat>EC</assetCat></invstOrSec>
        <invstOrSec><name>SP Funds S&amp;P Global REIT Sharia ETF</name><identifiers><other value="SPRE"/></identifiers><pctVal>0.50000000</pctVal><valUSD>16400000.00</valUSD><balance>865000</balance><assetCat>EC</assetCat></invstOrSec>
        <invstOrSec><name>Cash &amp; Other</name><identifiers><other value="CASH"/></identifiers><pctVal>-0.12000000</pctVal><valUSD>-3940000.00</valUSD><balance>0</balance><assetCat>CA</assetCat></invstOrSec>
        <invstOrSec><name>US TREASURY BILL 0% 09/17/2026</name><identifiers><cusip value="912797XX1"/></identifiers><pctVal>1.20000000</pctVal><valUSD>39400000.00</valUSD><balance>39400000</balance><assetCat>DBT</assetCat></invstOrSec>
      </invstOrSecs>
    </fundInfo>
  </formData>
</edgarSubmission>`;

/** Routes every outbound URL of an offline run to the inline samples. */
function sampleRoutes(overrides: Record<string, string> = {}): Array<[RegExp, (match: RegExpExecArray) => string]> {
  return [
    [/^https:\/\/www\.sp-funds\.com\/$/, () => overrides['home'] ?? HOME_HTML],
    [/^https:\/\/www\.sp-funds\.com\/([a-z]+)\/$/, (match) => overrides[match[1]] ?? fundPageHtml(match[1].toUpperCase())],
    [/TidalFG_Holdings_([A-Z]+)\.csv$/, (match) => overrides[`csv-${match[1]}`] ?? holdingsCsv(match[1])],
    [/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([A-Z]+)/, (match) => overrides[`yahoo-${match[1]}`] ?? yahooJson(match[1])],
    [/data\.sec\.gov\/submissions\/CIK0001742912/, () => overrides['tidal'] ?? EDGAR_SUBMISSIONS],
    [/company_tickers_mf\.json/, () => overrides['series'] ?? JSON.stringify(SERIES_PAYLOAD)],
    [/browse-edgar/, () => overrides['atom'] ?? '<feed></feed>'],
    [/primary_doc\.xml$/, () => overrides['nport'] ?? ''],
  ];
}

function sampleFetcher(overrides: Record<string, string> = {}, delayMs = 0) {
  const seen: string[] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const fetcher = async (url: string): Promise<Response> => {
    seen.push(url);
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      for (const [pattern, body] of sampleRoutes(overrides)) {
        const match = pattern.exec(url);
        if (match) return new Response(body(match), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetcher: fetcher as unknown as typeof fetch, seen, stats };
}

async function tempApiRoot(): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'spfunds-feed-'));
  tempDirs.push(dir);
  return new URL(`file://${dir}/api/spfunds/`);
}

const offlineConfig = (overrides: Record<string, string> = {}): UpdaterConfig =>
  readConfig({ TICKERS: TICKERS.join(' '), REQUEST_SLEEP: '0', CONCURRENCY: '4', SEC_UA: 'tests', ...overrides });

const fundFor = (ticker: string): CatalogFund => ({
  ticker, name: null, category: null, fundPage: fundPageUrl(ticker), inceptionDate: null,
  terValue: null, netTerValue: null, aumValue: null, officialReturns: { asOfDate: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
});

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');


const NOW = new Date('2026-10-01T12:00:00Z');
const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);
const quietTransport = (fetcher: typeof fetch): Transport => createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
const readMeta = async (apiRoot: URL, ticker: string): Promise<JsonRecord> => JSON.parse(await readFile(new URL(`funds/${ticker}/meta.json`, apiRoot), 'utf8'));
const readIndex = async (apiRoot: URL): Promise<JsonRecord> => JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
const tickersOf = (index: JsonRecord): string[] => (index['funds'] as JsonRecord[]).map((fund) => fund['ticker'] as string);
const stripTables = (html: string, marker: string): string =>
  html.replace(/<table>[\s\S]*?<\/table>/g, (table) => (table.includes(marker) ? '' : table));
const failing = (fetcher: typeof fetch, needle: string, status = 404): typeof fetch =>
  ((url: string, init?: RequestInit) => url.includes(needle) ? Promise.resolve(new Response('no', { status })) : fetcher(url, init)) as typeof fetch;

async function listFiles(root: URL, prefix = ''): Promise<string[]> {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, `${path}/`));
    else files.push(path);
  }
  return files.sort();
}

/** One published SPUS fund in a fresh temp feed; the temp dirs are removed in afterEach. */
async function publishedSpus(): Promise<URL> {
  const apiRoot = await tempApiRoot();
  await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(sampleFetcher().fetcher), null, NOW);
  return apiRoot;
}

const yahooWindow = (count: number, startEpoch: number): string => JSON.stringify({
  chart: { result: [{
    meta: { fullExchangeName: 'NYSEArca', longName: 'X' },
    timestamp: Array.from({ length: count }, (_, index) => startEpoch + index * 86_400),
    events: { dividends: {} },
    indicators: {
      quote: [{ close: Array.from({ length: count }, () => 60), volume: Array.from({ length: count }, () => 5) }],
      adjclose: [{ adjclose: Array.from({ length: count }, () => 60) }],
    },
  }] },
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

describe('controls', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));

  test('the checked-in JSON holds exactly the canonical controls with the provider defaults', () => {
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(file).every((value) => typeof value === 'string')).toBe(true);
    expect(file['SEC_UA']).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(SEC_UA_DEFAULT).toBe(file['SEC_UA']);
    const config = readConfig(resolveControls(file));
    expect(config.tickers).toEqual([]);
    expect(config.maxFetches).toBe(0);
    expect(config.concurrency).toBe(2);
    expect(config.maxRetries).toBe(2);
    expect(config.historyRange).toBe('max');
    expect(config.edgarFallback).toBe(true);
    expect(config.skipSpFunds).toBe(false);
    expect(config.skipYahoo).toBe(false);
    expect(config.aumRange).toBeUndefined();
    expect(config.performanceRanges).toEqual({});
  });

  test('precedence: file < advanced < nonblank input < environment; blank input inherits; env wins even when empty', () => {
    const resolve = (...layers: Array<Record<string, unknown>>) => resolveControls(layers[0], layers[1] ?? {}, (layers[2] ?? {}) as Record<string, string>, (layers[3] ?? {}) as Record<string, string>);
    expect(resolve({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolve({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolve({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '5' }).CONCURRENCY).toBe('5');
    expect(resolve({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolve({ TICKERS: 'SPUS' }, { TICKERS: 'SPRE' }, { TICKERS: '' }).TICKERS).toBe('SPRE');
    expect(resolve({ TICKERS: 'SPUS' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolve({ TICKERS: 'SPUS' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolve({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    // brand env alias, unrelated variables are ignored, the scheduled path equals the defaults
    expect(resolve({}, {}, {}, { SKIP_SP_FUNDS: 'true' }).SKIP_SPFUNDS).toBe('true');
    expect(resolveControls(file, {}, {}, { PATH: '/bin', HOME: '/root' })).toEqual(resolveControls(file));
    expect(resolveControls(file, {}, { TICKERS: '', MAX_FETCHES: '' }, {})).toEqual(resolveControls(file));
  });

  test('runtimeControls reads the checked-in file and lets the given environment win', async () => {
    expect(await runtimeControls({})).toEqual(resolveControls(file));
    const controls = await runtimeControls({ TICKERS: 'SPUS SPWO', MAX_RETRIES: '3', SEC_UA: '' });
    expect(readConfig(controls).maxRetries).toBe(3);
    expect(readConfig(controls).tickers).toEqual(['SPUS', 'SPWO']);
    expect(controls['SEC_UA']).toBe('');
    expect(readConfig(controls).secUa).toBe(SEC_UA_DEFAULT); // the code default still identifies the feed
  });

  test('strict validation: bad values, unknown keys, non-scalars and CR/LF/NUL are errors, never fallbacks', () => {
    const invalid: unknown[] = [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\rfoo' }, { SEC_UA: 'x\0y' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 },
      { MAX_FETCHES: 1.5 }, { MAX_FETCHES: '-1' }, { REQUEST_SLEEP: '-1' }, { REQUEST_SLEEP: 'fast' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' },
      { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: '2' }, { AUM: '1:2:3' }, { AUM: 'huge' }, { AUM: '5B:1B' }, { TER: 'a:b' }, { TER: '2' },
      { PERFORMANCE_1Y: '10:0' }, { TOTAL_RETURN_YTD: ':x' }, { HISTORY_RANGE: '1mo' }, { HISTORY_RANGE: '0y' }, { HOLDINGS_PAGE_SIZE: 0 },
      { HISTORY_PAGE_SIZE: 'big' }, { TICKERS: ['SPUS'] }, { TICKERS: { a: 1 } }, null, [], 'text',
    ];
    for (const value of invalid) expect(() => resolveControls(value), JSON.stringify(value)).toThrow();
    expect(() => resolveControls({}, null)).toThrow();
    expect(() => resolveControls({}, {}, { CONCURRENCY: 'x\n1' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'a\nb' })).toThrow();
    expect(() => resolveControls({}, {}, { UNKNOWN: 'x' })).toThrow('Unknown updater control');
    expect(() => parseRange('nonsense')).toThrow();
  });

  test('valid values are typed; zero and false are honoured; ranges and AUM presets parse', () => {
    const config = readConfig({ MAX_FETCHES: '0', REQUEST_SLEEP: '0', SKIP_YAHOO: 'false', EDGAR_FALLBACK: '0', MAX_RETRIES: '1', HISTORY_RANGE: '5Y', TICKERS: 'spus;spwo, spre' });
    expect([config.maxFetches, config.requestSleep, config.skipYahoo, config.edgarFallback, config.maxRetries]).toEqual([0, 0, false, false, 1]);
    expect(config.historyRange).toBe('5y');
    expect(config.tickers).toEqual(['SPUS', 'SPWO', 'SPRE']);
    expect(parseRange('1:5')).toEqual({ min: 1, max: 5 });
    expect(parseRange(':5')).toEqual({ min: -Infinity, max: 5 });
    expect(parseRange('2:')).toEqual({ min: 2, max: Infinity });
    expect(parseRange(':')).toBeUndefined();
    expect(parseAumRange('mid')).toEqual({ min: 2e9, max: 1e10, source: 'mid' });
    expect(parseAumRange('500M:2B')).toEqual({ min: 5e8, max: 2e9, source: '500M:2B' });
    const filters = readConfig({ AUM: '1B:', TER: '0:0.5', PERFORMANCE_1Y: '0:100', TOTAL_RETURN_3Y: ':', SEC_YIELD: '0.4:5' });
    expect(filters.aumRange!.min).toBe(1e9);
    expect(filters.terRange!.max).toBe(0.5);
    expect(filters.performanceRanges['1Y']).toEqual({ min: 0, max: 100 });
    expect(filters.totalReturnRanges['3Y']).toBeUndefined();
    expect(filters.secYieldRange!.min).toBe(0.4);
  });

  test('filters AND together and report every failing dimension; a true zero is not missing data', () => {
    expect(matchesRange(0, { min: 0, max: 1 })).toBe(true);
    expect(matchesRange(0, { min: 0.1, max: 1 })).toBe(false);
    expect(matchesRange(null, { min: 0, max: 1 })).toBe(false);
    expect(matchesRange(null, undefined)).toBe(true);
    const config = readConfig({ AUM: '1B:', TER: '0:0.5', PERFORMANCE_1Y: '0:20' });
    const entry = {
      ticker: 'SPUS', aumValue: 3.28e9, terValue: 0.45, secYield: 0.4, dividendYield: 0.52,
      returns: { asOfDate: null, ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 }, metrics: null,
    };
    expect(fundFilterReasons(entry, config)).toEqual(['performance_1y']);
    expect(fundFilterReasons({ ...entry, aumValue: 1e8, terValue: 0.9 }, config)).toEqual(['aum', 'ter', 'performance_1y']);
    expect(fundFilterReasons(entry, readConfig({}))).toEqual([]);
    const selection = selectionEntryFromIndex({ ticker: 'SPUS', aumValue: 3.28e9, terValue: 0.45, returns: { monthEnd: { yr1: 21.21 } }, metrics: { secYield: 0.4 } })!;
    expect(selection.returns.yr1).toBe(21.21);
    expect(selection.metrics!.secYield).toBe(0.4);
    expect(selectionEntryFromIndex(undefined)).toBeNull(); // a fund without a published entry is always kept
    expect(periodKey('10Y')).toBe('yr10');
  });

  test('USE_SYSTEM_CA is auto by default, case-insensitive and strict; certificate errors are detected through cause', () => {
    expect(file.USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(() => readConfig(resolveControls(file, {}, {}, { USE_SYSTEM_CA: value }))).not.toThrow();
    }
    expect(() => resolveControls(file, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa leaves fetch alone for false or an active store, restarts for true, wraps fetch for auto', async () => {
    const original = globalThis.fetch;
    const never = (): never => { throw new Error('unexpected reexec'); };
    installSystemCa('false', never, false);
    expect(globalThis.fetch).toBe(original);
    installSystemCa('auto', never, true);
    expect(globalThis.fetch).toBe(original);
    expect(() => installSystemCa('true', (() => { throw new Error('reexec'); }) as () => never, false)).toThrow('reexec');

    let reexecs = 0;
    const reexec = (): never => { reexecs++; throw new Error('reexec'); };
    let next: () => Promise<Response> = async () => new Response('ok');
    globalThis.fetch = (async () => next()) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('https://example.test/')).text()).toBe('ok');
    next = async () => { throw new Error('HTTP 403'); };
    await expect(fetch('https://example.test/')).rejects.toThrow('HTTP 403');
    expect(reexecs).toBe(0);
    next = async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); };
    await expect(fetch('https://example.test/')).rejects.toThrow('reexec');
    expect(reexecs).toBe(1);
  });

  test('the SEC contact is redacted in the config log', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      outputPrintConfig('SP Funds', readConfig({ SEC_UA: 'secret contact' }) as unknown as JsonRecord, {});
      const text = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(text).toContain('SEC_UA=<redacted>');
      expect(text).not.toContain('secret contact');
      expect(text).not.toContain('daggerok@gmail.com');
    } finally {
      log.mockRestore();
    }
  });

  test('scripts/ holds the three standard files, the updater is executable and writes only below api/spfunds', () => {
    expect(readdirSync(new URL('./', import.meta.url)).sort()).toEqual(['update-data.config.json', 'update-data.test.ts', 'update-data.ts']);
    const source = read('scripts/update-data.ts');
    const lines = source.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bun');
    expect(lines[1]).toBe('/// <reference types="bun" />');
    expect(statSync(new URL('./update-data.ts', import.meta.url)).mode & 0o111).not.toBe(0);
    expect(source).not.toContain('example.com');
    expect(source).toMatch(/new URL\('\.\.\/api\/spfunds\/', import\.meta\.url\)/);
    expect(source).not.toMatch(/OUTPUT_DIR/);
  });

  test('the workflow is the generated template: scheduled, <= 25 inputs, advanced JSON, secure, fixed output dir', () => {
    const workflow = read('.github/workflows/update-data.yml');
    const parsed = (Bun as unknown as { YAML: { parse(text: string): Record<string, any> } }).YAML.parse(workflow);
    const inputs = parsed['on']['workflow_dispatch']['inputs'] as Record<string, { default: string }>;
    const names = Object.keys(inputs);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(inputs['advanced'].default).toBe('{}');
    for (const name of names.filter((value) => value !== 'advanced')) {
      expect(CONTROL_NAMES as readonly string[], name).toContain(name.toUpperCase());
      expect(inputs[name].default).toBe('');
    }
    expect(parsed['on']['schedule'][0]['cron']).toBe('0 0 * * 0');
    expect(parsed['permissions']['contents']).toBe('write');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(workflow).not.toMatch(/\$\{\{\s*inputs\./);
    expect(workflow).not.toMatch(/OUTPUT_DIR|OUT_DIR/);
    expect(workflow).toContain('git add api/spfunds\n');
    expect(workflow.match(/git add /g)!.length).toBe(1);
    expect(workflow.indexOf('bun test')).toBeLessThan(workflow.indexOf('bun ./scripts/update-data.ts'));
    expect(readdirSync(new URL('../.github/workflows/', import.meta.url)).sort()).toEqual(['update-data.yml']);
  });

  test('the README follows the standard order and its controls table, --help and CONTROL_NAMES stay in sync', () => {
    const doc = read('README.md');
    const order = ['## Using Bun', '## Updating the static SP Funds data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
    let last = -1;
    for (const heading of order) {
      const index = doc.indexOf(`\n${heading}\n`);
      expect(index, heading).toBeGreaterThan(last);
      last = index;
    }
    for (const command of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) {
      expect(doc).toContain(command);
    }
    const section = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
    for (const name of CONTROL_NAMES) {
      expect(section, name).toContain(`| \`${name}\` |`);
      expect(USAGE, name).toContain(name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '_<P>'));
    }
    const rows = [...section.matchAll(/^\| `([A-Z_0-9]+)`/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual([...CONTROL_NAMES].sort());
    expect(doc).toContain(SEC_UA_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('numbers keep zero and negatives, placeholders become null, never 0', () => {
    expect(['0', 0, '-1.25%', '($1,234.5)', ' $2,500.25 ', '$59.54', '$3.28B', null, undefined, '', ' ', '—', '–', '--', 'N/A', 'garbage'].map(numberOrNull))
      .toEqual([0, 0, -1.25, -1234.5, 2500.25, 59.54, null, null, null, null, null, null, null, null, null, null]);
    expect(parseMoneyNumber('$3274.89m')).toBe(3274890000);
    expect(parseMoneyNumber('55,000,000')).toBe(55000000);
    expect(parseMoneyNumber('')).toBeNull();
    expect(sanitizeTicker(' spus ')).toBe('SPUS');
  });

  test('dates normalise to UTC whatever the process time zone is; impossible dates are null', () => {
    const saved = process.env['TZ'];
    try {
      for (const zone of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
        process.env['TZ'] = zone;
        expect(toIsoDate('10/01/2026')).toBe('2026-10-01');
        expect(toIsoDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
        expect(toIsoDate('Jun 04 2026')).toBe('2026-06-04');
        expect(formatSheetDate('Jun 04 2026')).toBe('Jun 04 2026');
        expect(formatSheetDate('10/1/2026')).toBe('Oct 01 2026');
        expect(formatUsDate('10/1/2026')).toBe('Oct 1 2026');
      }
    } finally {
      if (saved === undefined) delete process.env['TZ']; else process.env['TZ'] = saved;
    }
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('—')).toBeNull();
    expect(formatUsDate('nope')).toBeNull();
    expect(normalizeWeightText('14.14%')).toBe('14.14');
    expect(normalizeWeightText('')).toBe('');
    expect(formatMoneyText(null)).toBe('—');
    expect(formatAumDisplay(3283824025)).toBe('$3.28B');
    expect(round(0.5249999, 2)).toBe(0.52);
  });

  test('the Our ETFs menu yields the five SP Funds ETFs; the menu link wins over cards; non-fund links are ignored', () => {
    const catalog = buildCatalog(HOME_HTML, []);
    expect(catalog.map((fund) => fund.ticker)).toEqual(TICKERS);
    expect(catalog.find((fund) => fund.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(parseCatalogCards(HOME_HTML).find((card) => card.ticker === 'SPUS')!.fundPage).toBe('https://www.sp-funds.com/spus/');
    const synthetic = `<li><a href="#"><span>Our ETFs</span></a><ul class="sub-menu"><li><a href="/spre/"><span>SPRE</span></a></li></ul></li>
      <div class="bdt-ep-advanced-icon-box-content"><h3 class="bdt-ep-advanced-icon-box-title"><span>SPRE</span></h3>
      <a class="bdt-ep-advanced-icon-box-readmore" href="/spre-2/">See Details</a></div>`;
    expect(parseCatalogCards(synthetic)[0].fundPage).toBe('https://www.sp-funds.com/spre-2/');
    expect(buildCatalog(synthetic, [])[0].fundPage).toBe('https://www.sp-funds.com/spre/');
    const withOther = HOME_HTML.replace('</ul></li>', '</ul></li><li><a href="#"><span>Target Date Funds</span></a><ul class="sub-menu"><li><a href="/sptax/"><span>SPTAX</span></a></li></ul></li>');
    expect(parseCatalogMenu(withOther).length).toBe(5);
    expect(parseCatalogMenu(withOther).map((card) => card.ticker)).not.toContain('SPTAX');
  });

  test('an explicit TICKERS selection narrows and extends the catalog; unknown markup falls back to the known lineup', () => {
    expect(buildCatalog(HOME_HTML, ['SPUS', 'SPWO']).map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    const extra = buildCatalog(HOME_HTML, ['SPUS', 'ZZZZ']);
    expect(extra.find((fund) => fund.ticker === 'ZZZZ')!.fundPage).toBe('https://www.sp-funds.com/zzzz/');
    expect(buildCatalog('<html>redesigned</html>', []).map((fund) => fund.ticker)).toEqual(TICKERS);
    expect(buildCatalog('<p>no cards</p>', ['SPUS']).map((fund) => fund.fundPage)).toEqual(['https://www.sp-funds.com/spus/']);
  });

  test('SPUS fund page: identity, pricing, month-end NAV returns, benchmark, documents and distribution calendar', () => {
    const page = parseFundPage(fundPageHtml('SPUS'), 'SPUS');
    expect(page.name).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(lookupPattern(page.details, /fund inception/i)).toBe('12/17/2019');
    expect(lookupPattern(page.details, /cusip/i)).toBe('886364801');
    expect(lookupPattern(page.details, /expense ratio/i)).toBe('0.45%');
    expect(lookupPattern(page.details, /sec yield/i)).toBe('0.40%');
    expect(lookupPattern(page.pricing, /net assets/i)).toBe('$3274.89m');
    expect(lookupPattern(page.pricing, /^nav$/i)).toBe('$59.54');
    expect(page.pricingAsOf).toBe('2026-09-30');
    expect(page.monthEnd!.tickerRow).toBe('SPUS NAV');
    expect(page.monthEnd!.returns).toEqual({ asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 });
    expect(page.benchmark).toBe('SPSIEUT');
    expect(page.documents['prospectus']).toContain('spfunds-PRO_032626_web.pdf');
    expect(page.documents['factsheet']).toContain('SPUS-Factsheet-2026-Q2.pdf');
    expect(page.holdingsCsvUrl).toBe(holdingsCsvUrl('SPUS'));
    expect(page.distributions.length).toBe(6);
    expect(page.distributions[0]).toEqual({ exDate: '2026-09-28', recordDate: '2026-09-28', payDate: '2026-09-29', amount: 0.026 });
    expect(trustForTicker('SPUS')).toBe(TIDAL_TRUST);
    expect(trustForTicker('SPWO')).toBe(SPFUNDS_TRUST);
    for (const ticker of TICKERS) {
      const parsed = parseFundPage(fundPageHtml(ticker), ticker);
      expect(parsed.name, ticker).toBeTruthy();
      expect(lookupPattern(parsed.details, /cusip/i), ticker).toMatch(/^[0-9A-Z]{9}$/);
    }
  });

  test('SPTE (young fund): month-end and quarter-end tables differ and tenors older than the fund are null, not 0', () => {
    const spte = parseFundPage(fundPageHtml('SPTE'), 'SPTE');
    expect(spte.monthEnd!.returns.asOfDate).toBe('2026-08-31');
    expect(spte.monthEnd!.returns.ytd).toBe(34.78);
    expect(spte.quarterEnd!.returns.asOfDate).toBe('2026-06-30');
    expect(spte.monthEnd!.returns.yr3).toBeNull(); // the site prints 0.00: the fund is younger than 3 years
    expect(spte.quarterEnd!.returns.yr3).toBeNull();
    expect(spte.monthEnd!.returns.yr1).toBe(51.03);
    expect(spte.monthEnd!.returns.yr5).toBeNull();
    const tables = parseHtmlTables('<table id="x"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(tables).toEqual([{ start: 0, id: 'x', headers: ['A', 'B'], rows: [['1', '2']] }]);
    expect(nameValueMap([['Net Assets', '$3.28B'], ['Net Assets', 'ignored']]).get('Net Assets')).toBe('$3.28B');
  });

  test('holdings CSV: positions map onto the shared contract, categories come from the row, cash keeps its negative sign', () => {
    const parsed = parseSpFundsHoldingsCsv(holdingsCsv('SPUS'));
    expect(parsed.headers).toEqual(HOLDINGS_HEADERS);
    expect(parsed.rows.length).toBe(6);
    expect(parsed.asOfDate).toBe('2026-10-01');
    expect(parsed.netAssets).toBe(3283824025);
    expect(parsed.sharesOutstanding).toBe(55150000);
    expect(parsed.rows[0]).toEqual({
      Name: 'NVIDIA Corp', Ticker: 'NVDA', Identifier: '67066G104', Weight: '14.14',
      'Market Value': '464404792.12', 'Shares Held': '2033474', 'Asset Category': 'Equity',
    });
    expect(parsed.rows.every((row) => Object.keys(row).length === HOLDINGS_HEADERS.length)).toBe(true);
    expect(spFundsAssetCategory('Cash&Other', 'Cash & Other')).toBe('Cash');
    expect(spFundsAssetCategory('', 'US Treasury Bill')).toBe('Fixed Income');
    expect(spFundsAssetCategory('SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF')).toBe('Fund');
    expect(spFundsAssetCategory('WELL', 'Welltower Inc')).toBe('Equity');
    expect(spFundsAssetCategory('SPXW 261001P07075000', 'SPXW Oct 2026 7075 Put')).toBe('Option');
    const cash = parseSpFundsHoldingsCsv(holdingsCsv('SPRE')).rows.find((row) => row['Asset Category'] === 'Cash')!;
    expect(Number(cash.Weight.replace('%', ''))).toBeLessThan(0);
  });

  test('CSV quoting, BOM and CRLF are handled; empty, headerless and truncated files never invent rows', () => {
    expect(parseCsv('﻿a,b,c\r\n"x, y",2,"say ""hi"""\r\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['x, y', '2', 'say "hi"'], ['1', '2', '3']]);
    expect(parseSpFundsHoldingsCsv('').rows).toEqual([]);
    expect(() => parseSpFundsHoldingsCsv('Date,Weird\n1,2\n')).toThrow('StockTicker');
    const truncated = holdingsCsv('SPUS').split('\n').slice(0, 4).join('\n');
    expect(parseSpFundsHoldingsCsv(truncated).rows.length).toBe(3);
  });

  test('Yahoo chart: newest first, cents-rounded closes, first trade date; an empty result fails; official dates win in dividends', () => {
    const chart = parseYahooChart(JSON.parse(yahooJson('SPUS')));
    expect(chart.days.length).toBe(30);
    expect(chart.days[0].date >= chart.days[1].date).toBe(true);
    expect(chart.days.every((item) => Number(item.close.toFixed(2)) === item.close && Number(item.adjClose.toFixed(2)) === item.adjClose)).toBe(true);
    expect(chart.firstTradeDate).toBe('2019-12-18');
    expect(chart.exchange).toBe('NYSEArca');
    expect(chart.dividends[0].exDate >= chart.dividends[1].exDate).toBe(true);
    expect(chart.dividends[0].amount).toBe(0.026);
    expect(() => parseYahooChart({ chart: { result: null } })).toThrow('empty result');
    expect(() => parseYahooChart({})).toThrow('empty result');
    const merged = mergeDividends([{ exDate: '2026-09-28', recordDate: '2026-09-28', payDate: '2026-09-29', amount: 0.026 }], [
      { epoch: 1, amount: 0.026, exDate: '2026-09-28', recordDate: null, payDate: null },
      { epoch: 2, amount: 0.02, exDate: '2026-08-26', recordDate: null, payDate: null },
    ]);
    expect(merged.map((row) => row.exDate)).toEqual(['2026-09-28', '2026-08-26']);
    expect(merged[0].payDate).toBe('2026-09-29');
  });

  test('EDGAR: ticker table, validated urls, NPORT-P accessions from the trust feed and the series Atom feed', () => {
    const map = parseFundTickerMap(SERIES_PAYLOAD);
    expect(map.get('SPUS')).toEqual({ cik: '0001742912', seriesId: 'S000070027', classId: 'C000220954' });
    expect(map.get('SPTE')!.cik).toBe('0001989916');
    expect(map.has('SPWO')).toBe(false);
    expect(parseFundTickerMap({ fields: ['symbol', 'cik'], data: [['SPUS', '0'], ['', '1742912']] }).size).toBe(0);
    expect(nportUrlFor('0001742912', '0002000324-26-004454')).toBe('https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/primary_doc.xml');
    expect(() => nportUrlFor('1742912', 'not-an-accession')).toThrow('EDGAR');
    expect(edgarSeriesFilingsUrl('S000070027')).toContain('CIK=S000070027');
    const filings = parseNportAccessions(JSON.parse(EDGAR_SUBMISSIONS));
    expect(filings.map((filing) => filing.accession)).toEqual(['0002000324-26-004454', '0002000324-26-003796']);
    expect(filings[0].reportDate).toBe('2026-07-31');
    expect(parseNportAccessions({ cik: '1', filings: { recent: { form: ['10-K'], accessionNumber: ['x'] } } })).toEqual([]);
    const atom = `<feed><entry><filing-type>NPORT-P</filing-type><filing-date>2026-09-21</filing-date>
      <period>2026-07-31</period><accession-number>0002000324-26-004454</accession-number>
      <filing-href>https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/0002000324-26-004454-index.htm</filing-href></entry>
      <entry><filing-type>N-PORT</filing-type><accession-number>0000000000-00-000000</accession-number></entry></feed>`;
    expect(parseEdgarAtomFilings(atom).map((filing) => filing.url)).toEqual(['https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/primary_doc.xml']);
    expect(parseEdgarAtomFilings('<feed></feed>')).toEqual([]);
  });

  test('N-PORT reader keeps identifiers, weights, values and balances; a filing only matches its own series and registrant', () => {
    const parsed = parseNport(NPORT_XML);
    expect(parsed.seriesId).toBe('S000070027');
    expect(parsed.repPdDate).toBe('2026-07-31');
    expect(parsed.netAssets).toBe(3283824025);
    expect(parsed.holdings.length).toBe(5);
    expect(parsed.holdings[0]).toEqual({
      Name: 'NVIDIA CORP', Ticker: '—', Identifier: '67066G104', Weight: '14.14',
      'Market Value': '464404792.12', 'Shares Held': '2033474', 'Asset Category': 'EC',
    });
    expect(parsed.holdings[3].Weight).toBe('-0.12');
    const map = parseFundTickerMap(SERIES_PAYLOAD);
    const ref = map.get('SPUS')!;
    expect(matchesNportFund(parsed, 'SPUS', null, ref, TIDAL_TRUST.cik)).toBe(true);
    expect(matchesNportFund(parsed, 'SPRE', null, map.get('SPRE')!, TIDAL_TRUST.cik)).toBe(false);
    expect(matchesNportFund(parsed, 'SPUS', null, { ...ref, cik: '0000000001' }, TIDAL_TRUST.cik)).toBe(false);
    expect(matchesNportFund(parsed, 'SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF', null, TIDAL_TRUST.cik)).toBe(true);
    expect(matchesNportFund(parsed, 'SPUS', 'SP Funds Dow Jones Global Sukuk ETF', null, TIDAL_TRUST.cik)).toBe(false);
    const names = parseCompanyTickerMap({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
    const rows: SheetRow[] = [
      { 'Name': 'Apple Inc', 'Ticker': '—', 'Identifier': '037833100', 'Weight': '1%', 'Market Value': '', 'Shares Held': '', 'Asset Category': 'EC' },
      { 'Name': 'US Treasury Bill', 'Ticker': '—', 'Identifier': '912797XX1', 'Weight': '1%', 'Market Value': '', 'Shares Held': '', 'Asset Category': 'DBT' },
    ];
    const filled = fillNportTickers(rows, names);
    expect([filled[0]['Ticker'], filled[1]['Ticker']]).toEqual(['AAPL', '—']);
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  const official = { asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 };

  test('cumulative total return and CAGR invert each other; unknown inputs stay null', () => {
    expect(cumulativeFromAnnualized(25.32, 3)).toBe(96.82);
    expect(annualizedFromCumulative(96.82, 3)).toBe(25.32);
    expect(cumulativeFromAnnualized(21.21, 1)).toBe(21.21);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-101, 3)).toBeNull();
  });

  test('official returns are published as-is, returnsBasis and performanceAsOf travel together as the last keys', () => {
    const metrics = deriveMetrics(official, 'Monthly', 0.026, 59.54, 0.4);
    expect(metrics.ytd).toBe(17.13);
    expect(metrics.tr3y).toBe(96.82);
    expect(metrics.tr5y).toBe(113.41);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.cagr3y).toBe(25.32);
    expect(metrics.siAnn).toBe(18.57);
    expect(metrics.dividendYield).toBe(0.52);
    expect(metrics.secYieldText).toBe('0.40%');
    expect(metrics.returnsBasis).toContain('official SP Funds month-end NAV total returns');
    expect(metrics.performanceAsOf).toBe('2026-09-30');
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    // performanceAsOf is the performance table date: null when unknown, never empty
    expect(performanceAsOf({ ...official, asOfDate: '2026-08-31' })).toBe('2026-08-31');
    expect(performanceAsOf({ ...official, asOfDate: '' })).toBeNull();
    expect(deriveMetrics({ ...official, asOfDate: null }, 'Monthly', 0.026, 59.54, 0.4).performanceAsOf).toBeNull();
    expect(deriveMetrics({ ...official, asOfDate: null }, 'Monthly', 0.026, 59.54, 0.4).returnsBasis.trim()).not.toBe('');
  });

  test('a missing yield, price or frequency is null, never a fabricated number', () => {
    const metrics = deriveMetrics(official, null, 0.026, 59.54, null);
    expect(metrics.dividendYield).toBeNull();
    expect(metrics.secYield).toBeNull();
    expect(metrics.secYieldText).toBe('—');
    expect(deriveMetrics(official, 'Monthly', 0.026, 0, 0.4).dividendYield).toBeNull();
  });

  test('frequency is derived only from the fund own published ex-dates', () => {
    expect([paymentsPerYear('Monthly'), paymentsPerYear('Quarterly'), paymentsPerYear('Annually'), paymentsPerYear('')]).toEqual([12, 4, 1, null]);
    const asOf = new Date('2026-10-01T00:00:00Z');
    expect(inferDistributionFrequency(['2026-09-28', '2026-08-26', '2026-07-27', '2026-06-26', '2026-05-27', '2026-04-27'], asOf)).toBe('Monthly');
    expect(inferDistributionFrequency(['2026-09-28', '2026-06-26'], asOf)).toBeNull();
    expect(inferDistributionFrequency([], asOf)).toBeNull();
    expect(inferDistributionFrequency(['2020-01-01', '2020-02-01', '2020-03-01'], asOf)).toBeNull();
  });

  test('tenorAvailable compares inception + N years with the table date', () => {
    expect(tenorAvailable('2023-11-30', '2026-08-31', 3)).toBe(false);
    expect(tenorAvailable('2023-11-30', '2026-11-30', 3)).toBe(true);
    expect(tenorAvailable('2019-12-17', '2026-09-30', 10)).toBe(false);
    expect(tenorAvailable(null, '2026-09-30', 10)).toBe(true);
  });

  test('a fund younger than three years publishes null, not 0, for 3-year total return and CAGR', async () => {
    const apiRoot = await tempApiRoot();
    await updateFund(fundFor('SPTE'), offlineConfig(), apiRoot, quietTransport(sampleFetcher().fetcher), null, NOW);
    const meta = await readMeta(apiRoot, 'SPTE');
    const metrics = meta['metrics'] as JsonRecord;
    expect(metrics['tr3y']).toBeNull();
    expect(metrics['cagr3y']).toBeNull();
    expect(metrics['tr1y']).toBe(51.03);
    expect(metrics['siAnn']).toBe(37.44);
    expect((meta['returns'] as JsonRecord)['monthEnd']).toMatchObject({ yr3: null, yr5: null, yr10: null });
    expect((meta['returns'] as JsonRecord)['quarterEnd']).toMatchObject({ yr3: null });
  });

  test('every index row has the same metrics key set; a row without meta is all null with a non-empty returnsBasis', async () => {
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig(), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const rows = (await readIndex(apiRoot))['funds'] as JsonRecord[];
    const expected = Object.keys(emptyMetrics()).sort();
    for (const row of rows) expect(Object.keys(row['metrics'] as JsonRecord).sort(), String(row['ticker'])).toEqual(expected);
    const placeholder = placeholderEntry('SPWO', 'https://www.sp-funds.com/spwo/');
    const metrics = placeholder['metrics'] as JsonRecord;
    expect(Object.keys(metrics).sort()).toEqual(expected);
    for (const key of expected.filter((name) => name !== 'returnsBasis' && !name.endsWith('Text'))) expect(metrics[key], key).toBeNull();
    expect(String(metrics['returnsBasis']).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

describe('pipeline', () => {
  test('SPUS: metadata, metrics and paged holdings/history land in the sibling contract', async () => {
    const apiRoot = await tempApiRoot();
    const transport = quietTransport(sampleFetcher().fetcher);
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig({ HOLDINGS_PAGE_SIZE: '4', HISTORY_PAGE_SIZE: '10' }), apiRoot, transport, null, NOW);
    expect(outcome.providers.spFunds).toBe(true);
    expect(outcome.providers.yahoo).toBe(true);
    expect(outcome.providers.retained).toEqual([]);
    expect(outcome.written).toBe(true);
    const meta = await readMeta(apiRoot, 'SPUS');
    expect(meta['name']).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(meta['ter']).toBe('0.45%');
    expect(meta['aum']).toBe('$3.27B');
    expect(meta['aumValue']).toBe(3274890000);
    expect(meta['asOfDate']).toBe('2026-09-30');
    expect(meta['inceptionDate']).toBe('2019-12-17');
    expect(meta['identifiers']).toEqual({ cusip: '886364801', isin: null, indexTicker: 'SPSIEUT', benchmark: 'S&P 500 Shariah Industry Exclusions Index (USD) TR' });
    expect((meta['yields'] as JsonRecord)['secYieldText']).toBe('0.40%');
    expect(((meta['returns'] as JsonRecord)['monthEnd'] as JsonRecord)['yr1']).toBe(21.21);
    const distributions = meta['distributions'] as JsonRecord;
    expect(distributions['frequency']).toBe('Monthly');
    expect((distributions['rows'] as string[][])[0]).toEqual(['2026-09-28', '2026-09-28', '2026-09-29', '0.026']);
    expect((meta['source'] as JsonRecord)['trustCik']).toBe('0001742912');
    expect(meta['holdings']).toEqual({ pages: ['001.json', '002.json'], pageSize: 4, totalRows: 6, asOfDate: '2026-10-01' });
    expect((meta['history'] as JsonRecord)['totalRows']).toBe(30);
    expect(((meta['history'] as JsonRecord)['pages'] as string[]).length).toBe(3);
    const holdings = JSON.parse(await readFile(new URL('funds/SPUS/holdings/001.json', apiRoot), 'utf8'));
    expect(Object.keys(holdings['rows'][0])).toEqual(HOLDINGS_HEADERS);
    expect(holdings['rows'][0]['Weight']).toBe('14.14');
    const history = JSON.parse(await readFile(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    expect(Object.keys(history['rows'][0])).toEqual(HISTORY_HEADERS);
  });

  test('a full run publishes every fund, then a second identical run writes nothing (zero diff)', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher, seen } = sampleFetcher();
    const first = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: NOW });
    expect(first.funds).toBe(5);
    expect(first.holdings).toBe(HOLDINGS_TOTAL);
    expect(first.history).toBe(HISTORY_TOTAL);
    expect(first.failures).toEqual([]);
    const index = await readIndex(apiRoot);
    expect(index['counts']).toEqual({ funds: 5, holdings: HOLDINGS_TOTAL, history: HISTORY_TOTAL });
    expect(index['provider']).toBe('SP Funds');
    const spus = (index['funds'] as JsonRecord[]).find((fund) => fund['ticker'] === 'SPUS')!;
    expect(Object.keys(spus).sort()).toEqual([
      'aum', 'aumValue', 'asOfDate', 'category', 'closePrice', 'closePriceAsOfDate', 'closePriceValue', 'cusip', 'dataFile',
      'distributions', 'exchange', 'fundPage', 'history', 'holdings', 'inceptionDate', 'isin', 'metrics', 'name',
      'nav', 'navValue', 'premiumDiscount', 'premiumDiscountValue', 'returns', 'ter', 'terGrossValue', 'terValue', 'ticker',
    ].sort());
    expect(spus['distributions']).toEqual({ frequency: 'Monthly', exDate: '2026-09-28', dividend: '0.026' });

    const tree = await listFiles(apiRoot);
    expect(tree.length).toBe(1 + 5 * 3); // index.json + meta, one holdings and one history page per fund
    const before = new Map<string, string>();
    for (const file of tree) before.set(file, await readFile(new URL(file, apiRoot), 'utf8'));
    seen.length = 0;
    const second = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: day(0.5) });
    expect(seen.length).toBeGreaterThan(0);
    expect(second.written).toBe(0);
    expect(await listFiles(apiRoot)).toEqual(tree);
    for (const file of tree) expect(await readFile(new URL(file, apiRoot), 'utf8'), file).toBe(before.get(file));
  });

  test('a one-ticker or bounded run keeps every catalog row and the files of unselected funds', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    await runUpdater(offlineConfig(), { apiRoot, fetcher, now: NOW });
    const before = await listFiles(apiRoot);
    const one = await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher, now: day(1) });
    expect(one.funds).toBe(1);
    expect(tickersOf(await readIndex(apiRoot))).toEqual(TICKERS);
    expect(await listFiles(apiRoot)).toEqual(before);

    const fresh = await tempApiRoot();
    await runUpdater(offlineConfig({ MAX_FETCHES: '1' }), { apiRoot: fresh, fetcher, now: NOW });
    const index = await readIndex(fresh);
    expect(tickersOf(index)).toEqual(TICKERS);
    expect(((index['funds'] as JsonRecord[])[2])['holdings']).toBe(0); // SPTE not fetched yet: placeholder row
  });

  test('the ticker cursor rotates bounded runs and resumes only in the same scope; a full pass clears it', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    expect((await runUpdater(offlineConfig({ MAX_FETCHES: '1' }), { apiRoot, fetcher, now: NOW })).funds).toBe(1);
    expect(await readCursor(apiRoot)).toBe('SPRE');
    expect(await readCursor(apiRoot, 'another-scope')).toBeNull();
    await writeCursor(apiRoot, null);
    expect(await readCursor(apiRoot)).toBeNull();
    expect((await runUpdater(offlineConfig({ MAX_FETCHES: '2' }), { apiRoot, fetcher, now: NOW })).funds).toBe(2);
    expect(await readCursor(apiRoot)).toBe('SPSK');
    expect((await runUpdater(offlineConfig(), { apiRoot, fetcher, now: day(0.5) })).funds).toBe(5);
    expect(await readCursor(apiRoot)).toBeNull();
    const catalog = buildCatalog(HOME_HTML, []);
    expect(batchSelection(catalog, 2, 'SPTE').map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    expect(batchSelection(catalog, 3, null).map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE']);
    batchSelection(catalog, 2, 'SPTE').splice(0);
    expect(catalog.length).toBe(5); // the batch never mutates the catalog
  });

  test('a filter run skips out-of-range funds but keeps their published entries', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    await runUpdater(offlineConfig(), { apiRoot, fetcher, now: NOW });
    expect((await readPreviousIndex(apiRoot)).size).toBe(5);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    let summary;
    try {
      summary = await runUpdater(offlineConfig({ AUM: '1B:' }), { apiRoot, fetcher, now: day(1) });
    } finally {
      log.mockRestore();
    }
    expect([...summary.skipped].sort()).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPWO']); // only SPUS publishes more than $1B
    expect(tickersOf(await readIndex(apiRoot))).toEqual(TICKERS);
  });

  test('a failed issuer source keeps the fund exactly as published and reports it', async () => {
    const apiRoot = await publishedSpus();
    const metaBefore = await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8');
    const { fetcher } = sampleFetcher();
    const broken: Transport = async (url, label, init) => {
      if (url.includes('TidalFG_Holdings')) throw new Error('HTTP 500');
      if (url.endsWith('.com/spus/')) throw new Error('HTTP 503');
      return quietTransport(fetcher)(url, label, init);
    };
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, broken, null, day(1));
    expect(outcome.providers.spFunds).toBe(false);
    expect(outcome.providers.retained).toEqual(expect.arrayContaining(['issuer page', 'holdings']));
    expect(outcome.failedSources).toEqual(['issuer page', 'holdings']);
    expect(outcome.written).toBe(false);
    expect(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8')).toBe(metaBefore);
  });

  test('a failed Yahoo request keeps the whole published fund, never a new return next to old history', async () => {
    const apiRoot = await publishedSpus();
    const before = await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8');
    const changed = fundPageHtml('SPUS').replace(/09\/30\/2026/g, '10/31/2026');
    const { fetcher } = sampleFetcher({ spus: changed });
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(failing(fetcher, 'yahoo')), null, day(1));
    expect(outcome.failedSources).toEqual(['Yahoo history']);
    expect(outcome.written).toBe(false);
    expect(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8')).toBe(before);
  });

  test('on a first run a failing Yahoo request does not stop the other funds', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const exploding = (async (url: string) => {
      if (url.includes('finance/chart/SPUS')) throw new Error('yahoo is down');
      return fetcher(url);
    }) as unknown as typeof fetch;
    const summary = await runUpdater(offlineConfig({ MAX_RETRIES: '1' }), { apiRoot, fetcher: exploding, now: NOW });
    expect(summary.funds).toBe(5);
    expect(summary.failures).toEqual([]);
    const meta = await readMeta(apiRoot, 'SPUS');
    expect((meta['history'] as JsonRecord)['totalRows']).toBe(0);
    expect((meta['holdings'] as JsonRecord)['totalRows']).toBe(6);
  });

  test('SKIP_SPFUNDS and SKIP_YAHOO make no request and keep the published feed untouched', async () => {
    const apiRoot = await publishedSpus();
    const before = await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8');
    const { fetcher, seen } = sampleFetcher();
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig({ SKIP_SPFUNDS: 'true', SKIP_YAHOO: 'true' }), apiRoot, quietTransport(fetcher), null, day(2));
    expect(seen.length).toBe(0);
    expect(outcome.written).toBe(false);
    expect(outcome.status).toBe('unchanged');
    expect(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8')).toBe(before);
  });

  test('a page without its performance or fact tables keeps the published values as one unit; a blank in a present table is null', async () => {
    const apiRoot = await publishedSpus();
    const before = await readMeta(apiRoot, 'SPUS');
    const noReturns = sampleFetcher({ spus: stripTables(fundPageHtml('SPUS'), 'Fund Ticker') });
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(noReturns.fetcher), null, day(1));
    const after = await readMeta(apiRoot, 'SPUS');
    expect(after['returns']).toEqual(before['returns']);
    expect((after['metrics'] as JsonRecord)['tr1y']).toBe(21.21);
    expect((after['metrics'] as JsonRecord)['performanceAsOf']).toBe('2026-09-30');
    expect((after['metrics'] as JsonRecord)['returnsBasis']).toBe((before['metrics'] as JsonRecord)['returnsBasis']);
    expect(outcome.reason).toContain('returns (table missing on the page)');

    const bare = stripTables(stripTables(stripTables(fundPageHtml('SPUS'), 'Fund Ticker'), 'Fund Inception'), 'Net Assets');
    const bareOutcome = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(sampleFetcher({ spus: bare }).fetcher), null, day(2));
    const meta = await readMeta(apiRoot, 'SPUS');
    expect([meta['terValue'], meta['navValue'], meta['aumValue']]).toEqual([0.45, 59.54, 3274890000]);
    expect(bareOutcome.reason).toContain('pricing (table missing on the page)');

    const noYield = fundPageHtml('SPUS').replace(/<tr><td>30 Day SEC Yield[^]*?<\/tr>/, '');
    await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(sampleFetcher({ spus: noYield }).fetcher), null, day(3));
    expect(((await readMeta(apiRoot, 'SPUS'))['metrics'] as JsonRecord)['secYield']).toBeNull();
  });

  test('an older N-PORT-P filing never replaces fresher published holdings (freshness), a newer one does', async () => {
    const apiRoot = await publishedSpus();
    const { fetcher } = sampleFetcher();
    const rows = [{ Name: 'Old', Ticker: 'OLD', Identifier: '1', Weight: '100', 'Market Value': '1', 'Shares Held': '1', 'Asset Category': 'Equity' }];
    const noCsv = quietTransport(failing(fetcher, 'TidalFG'));
    const stale = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, noCsv, async () => ({ rows, asOfDate: '2026-07-31', source: 's' }), day(1));
    expect(stale.providers.edgar).toBe(false);
    expect(stale.failedSources).toContain('holdings');
    expect((await readMeta(apiRoot, 'SPUS'))['holdings']).toMatchObject({ totalRows: 6, asOfDate: '2026-10-01' });
    const fresh = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, noCsv, async () => ({ rows, asOfDate: '2026-10-02', source: 's' }), day(2));
    expect(fresh.providers.edgar).toBe(true);
    expect((await readMeta(apiRoot, 'SPUS'))['holdings']).toMatchObject({ totalRows: 1, asOfDate: '2026-10-02' });
  });

  test('a row without a published meta.json has dataFile null; a soft deadline leaves unprocessed funds as such rows', async () => {
    expect(placeholderEntry('SPWO', 'https://www.sp-funds.com/spwo/')['dataFile']).toBeNull();
    let tick = 0; // fake clock: no wall-clock dependence
    const apiRoot = await tempApiRoot();
    const summary = await runUpdater(offlineConfig({ CONCURRENCY: '1' }), {
      apiRoot, fetcher: sampleFetcher().fetcher, now: NOW, deadlineMs: 2500, clock: () => { tick += 1000; return tick; },
    });
    expect(summary.deadlineHit).toBe(true);
    const funds = (await readIndex(apiRoot))['funds'] as JsonRecord[];
    expect(funds.length).toBe(5);
    expect(funds.filter((fund) => fund['dataFile'] !== null).length).toBe(2);
    expect(funds.filter((fund) => fund['dataFile'] === null).every((fund) => (fund['metrics'] as JsonRecord)['tr1y'] === null)).toBe(true);
    expect((await listFiles(apiRoot)).some((file) => file.includes('.tmp-'))).toBe(false);
  });

  test('a shorter HISTORY_RANGE refreshes its window and keeps the older published rows', async () => {
    const apiRoot = await publishedSpus();
    const windowed = sampleFetcher({ 'yahoo-SPUS': yahooWindow(10, 1_788_000_000 + 20 * 86_400) });
    await updateFund(fundFor('SPUS'), offlineConfig({ HISTORY_RANGE: '1y' }), apiRoot, quietTransport(windowed.fetcher), null, day(1));
    expect(((await readMeta(apiRoot, 'SPUS'))['history'] as JsonRecord)['totalRows']).toBe(30);
    const page = JSON.parse(await readFile(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    expect(page['rows'][0]['Date']).toBe('Aug 29 2026');
    expect(page['rows'][29]['Close']).toBe('60');
    expect(page['rows'][5]['Close']).toBe('59.05');
    expect(mergeHistoryDays([], [{ date: '2026-01-01', close: 1, adjClose: 1, volume: 1 }]).length).toBe(1);
  });

  test('tickers missing from the previous index are reported as new funds', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    await runUpdater(offlineConfig(), { apiRoot, fetcher, now: NOW });
    const index = await readIndex(apiRoot);
    index['funds'] = (index['funds'] as JsonRecord[]).filter((fund) => fund['ticker'] !== 'SPWO' && fund['ticker'] !== 'SPSK');
    await writeFile(new URL('index.json', apiRoot), JSON.stringify(index));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const summary = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: day(1) });
      expect(summary.newFunds).toEqual(['SPSK', 'SPWO']);
    } finally {
      log.mockRestore();
    }
  });

  test('published shapes: history oldest-first with month-name dates, second-precision stamps, plain numbers', async () => {
    const rows = historyRowsFromDays([
      { date: '2026-09-30', close: 2, adjClose: 2, volume: 1 }, { date: '2026-09-02', close: 1, adjClose: 1, volume: 1 },
    ]);
    expect(rows.map((row) => row['Date'])).toEqual(['Sep 02 2026', 'Sep 30 2026']);
    expect(dayFromHistoryRow(rows[1])?.date).toBe('2026-09-30');
    expect(isoStamp(new Date('2026-10-01T12:00:00.987Z'))).toBe('2026-10-01T12:00:00Z');
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig(), { apiRoot, fetcher: sampleFetcher().fetcher, now: new Date('2026-10-01T12:00:00.500Z') });
    const index = await readIndex(apiRoot);
    expect(index['generatedAt']).toBe('2026-10-01T12:00:00Z');
    const spte = (index['funds'] as JsonRecord[]).find((fund) => fund['ticker'] === 'SPTE')!;
    expect([spte['aumValue'], spte['closePriceValue'], spte['premiumDiscountValue']]).toEqual([261470000, 49.8, -0.01]);
    const history = JSON.parse(await readFile(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    const dates = history['rows'].map((row: SheetRow) => Date.parse(`${row['Date']} UTC`));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(history['asOfDate']).toBe('2026-09-27');
    const holdings = JSON.parse(await readFile(new URL('funds/SPTE/holdings/001.json', apiRoot), 'utf8'));
    expect([holdings['rows'][0]['Weight'], holdings['rows'][0]['Market Value']]).toEqual(['10', '150000']);
  });

  test('writers are idempotent: run timestamps never cause churn, pages split exactly and stale pages are removed', async () => {
    const published = (generatedAt: string, rows: number) => ({ generatedAt, count: { rows, nested: { generatedAt } }, funds: [{ ticker: 'SPUS', catalogReadAt: 'x' }] });
    expect(samePublishedContent(stableStringify(published('2026-10-01T00:00:00.000Z', 1)), published('2026-10-02T00:00:00.000Z', 1))).toBe(true);
    expect(samePublishedContent(stableStringify(published('a', 1)), published('a', 2))).toBe(false);
    expect(samePublishedContent('not json', published('now', 1))).toBe(false);
    expect(splitPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pageFileName(12)).toBe('012.json');
    const sheet: SheetRow[] = Array.from({ length: 5 }, (_, index) => ({ Name: `n${index}`, Ticker: `T${index}` }));
    const built = buildPages('SPUS', 'holdings', HOLDINGS_HEADERS, sheet, 2, '2026-10-01');
    expect(built.map((page) => page.name)).toEqual(['001.json', '002.json', '003.json']);
    expect(built[0].payload['totalRows']).toBe(5);

    const dir = await mkdtemp(join(tmpdir(), 'spfunds-write-'));
    tempDirs.push(dir);
    {
      const holdingsDir = new URL(`file://${dir}/holdings/`);
      await writePages(holdingsDir, 'SPUS', 'holdings', HOLDINGS_HEADERS, sheet, 2, '2026-10-01');
      expect((await readdir(holdingsDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      const manifest = await writePages(holdingsDir, 'SPUS', 'holdings', HOLDINGS_HEADERS, sheet.slice(0, 2), 2, '2026-10-01');
      expect((await readdir(holdingsDir)).sort()).toEqual(['001.json']);
      const previous = await readPreviousPages(holdingsDir, manifest);
      expect(previous.rows.length).toBe(2);
      expect(previous.rows[0]['Identifier']).toBe('');
      const file = new URL(`file://${dir}/index.json`);
      expect(await writeIfChanged(file, { generatedAt: 'a', value: 1 })).toBe(true);
      expect(await writeIfChanged(file, { generatedAt: 'b', value: 1 })).toBe(false);
      expect(JSON.parse(await readFile(file, 'utf8'))['generatedAt']).toBe('a');
      expect(await writeIfChanged(file, { generatedAt: 'b', value: 2 })).toBe(true);
    }
  });

  test('the catalog index carries the provider, trust and per-fund provenance', () => {
    const index = buildCatalogIndex('SP Funds', buildCatalog(HOME_HTML, []), HOLDINGS_TOTAL, HISTORY_TOTAL, '2026-10-01T00:00:00.000Z');
    expect(index['counts']).toEqual({ funds: 5, holdings: HOLDINGS_TOTAL, history: HISTORY_TOTAL });
    expect((index['source'] as JsonRecord)['trustCik']).toBe('0001742912');
    expect((index['source'] as JsonRecord)['nportTrustCik']).toContain('0001989916');
    expect(catalogIndexEntry({ entry: { ticker: 'SPUS' } } as unknown as FundOutcome)).toEqual({ ticker: 'SPUS' });
  });
});

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

describe('network', () => {
  test('independent request lanes start immediately; a lane waits only for its own pacing', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = createRequestGate(2, 1000, () => clock, async (ms: number) => { waits.push(ms); clock += ms; });
    await gate();
    await gate();
    expect(waits).toEqual([]);
    await gate();
    expect(waits).toEqual([1000]);
  });

  test('retries are bounded and only for transient statuses; permanent statuses fail at once', async () => {
    let attempts = 0;
    const transient = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }), async () => {}, (async () => {
      attempts += 1;
      return attempts < 3 ? new Response('busy', { status: 503 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch, async () => {});
    expect((await transient('https://example.test/a', 'test')).status).toBe(200);
    expect(attempts).toBe(3);

    let always = 0;
    const down = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }), async () => {}, (async () => { always += 1; return new Response('busy', { status: 503 }); }) as unknown as typeof fetch, async () => {});
    await expect(down('https://example.test/c', 'test')).rejects.toThrow('HTTP 503');
    expect(always).toBe(3); // one try plus MAX_RETRIES retries, never more

    let permanent = 0;
    const forbidden = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }), async () => {}, (async () => { permanent += 1; return new Response('no', { status: 403 }); }) as unknown as typeof fetch, async () => {});
    await expect(forbidden('https://example.test/b', 'test')).rejects.toThrow('HTTP 403');
    expect(permanent).toBe(1);
    expect(errorMessage(new Error('x'))).toBe('x');
  });

  test('every request carries a timeout signal that aborts the in-flight request and body', async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      let received: AbortSignal | undefined;
      const hanging = (async (_url: string, init?: RequestInit) => {
        received = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new Error('timed out'));
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        });
      }) as unknown as typeof fetch;
      const transport = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), async () => {}, hanging, async () => {});
      const pending = transport('https://example.test/slow', 'slow');
      controller.abort();
      let guard: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<string>((resolve) => { guard = setTimeout(() => resolve('hung: the request never saw the signal'), 2000); });
      const outcome = await Promise.race([pending.then(() => 'resolved', (error: Error) => error.message), hung]);
      clearTimeout(guard);
      expect(outcome).toBe('timed out');
      expect(received).toBe(controller.signal);
      const [ms] = timeout.mock.calls[0] as [number];
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(120_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test('SEC and Yahoo headers declare the right identity', () => {
    expect(secHeaders(readConfig({ SEC_UA: 'My Fund Feed me@mail.test' }))['User-Agent']).toBe('My Fund Feed me@mail.test');
    expect(secHeaders(readConfig({}))['User-Agent']).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(yahooHeaders()['User-Agent']).toContain('Mozilla');
  });

  test('CONCURRENCY=1 keeps one request in flight, CONCURRENCY=N overlaps up to N (one worker per fund at most)', async () => {
    const peak = async (concurrency: string): Promise<number> => {
      const run = sampleFetcher({}, 20);
      await runUpdater(offlineConfig({ CONCURRENCY: concurrency }), { apiRoot: await tempApiRoot(), fetcher: run.fetcher, now: NOW });
      return run.stats.maxInFlight;
    };
    expect(await peak('1')).toBe(1);
    expect(await peak('3')).toBe(3);
    expect(await peak('15')).toBe(5);
  });

  test('HISTORY_RANGE reaches the Yahoo request as explicit period1/period2 (Yahoo ignores range with period1=0)', async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const start = (url: string): number => Number(new URL(url).searchParams.get('period1'));
    expect(start(yahooChartUrl('SPUS', 'max', NOW.getTime()))).toBe(0);
    const five = yahooChartUrl('SPUS', '5y', NOW.getTime());
    expect(start(five)).toBe(Math.floor(seconds - 5 * 365.25 * 86_400));
    expect(start(five)).toBeGreaterThan(start(yahooChartUrl('SPUS', '10y', NOW.getTime())));
    expect(new URL(five).searchParams.get('period2')).toBe(String(seconds + 86_400));
    expect(new URL(five).searchParams.has('range')).toBe(false);

    const { fetcher, seen } = sampleFetcher();
    await runUpdater(offlineConfig({ HISTORY_RANGE: '5y', TICKERS: 'SPUS' }), { apiRoot: await tempApiRoot(), fetcher, now: NOW });
    const chart = seen.filter((url) => url.includes('finance.yahoo.com'));
    expect(chart.length).toBe(1);
    expect(start(chart[0])).toBe(Math.floor(seconds - 5 * 365.25 * 86_400));
  });

  test('the EDGAR fallback walks the series feed, rejects other series and reports the filing URL', async () => {
    const calls: string[] = [];
    const atom = '<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0002000324-26-004454</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/x-index.htm</filing-href></entry></feed>';
    const transport: Transport = async (url) => {
      calls.push(url);
      if (url.includes('browse-edgar')) return new Response(atom, { status: 200 });
      if (url.includes('primary_doc.xml')) return new Response(NPORT_XML, { status: 200 });
      if (url.includes('company_tickers')) return new Response(JSON.stringify(SERIES_PAYLOAD), { status: 200 });
      return new Response(EDGAR_SUBMISSIONS, { status: 200 });
    };
    const fallback = createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, () => {});
    const result = await fallback('SPUS', null);
    expect(result!.asOfDate).toBe('2026-07-31');
    expect(result!.rows.length).toBe(5);
    expect(result!.source).toContain('000200032426004454');
    expect(Number(result!.rows[0]['Weight'])).toBeGreaterThan(Number(result!.rows[1]['Weight'])); // sorted by weight descending
    const cash = result!.rows.find((row) => row['Name'] === 'Cash & Other')!;
    expect([cash['Market Value'], cash['Weight']]).toEqual(['-3940000', '-0.12']);
    expect(calls.some((url) => url.includes('submissions'))).toBe(false);
    calls.length = 0;
    expect(await fallback('SPRE', null)).toBeNull(); // another series' filing is rejected, rows are never mixed
    expect(calls.filter((url) => url.includes('primary_doc.xml')).length).toBe(1);
  });

  test('the EDGAR fallback refuses a registrant outside the two verified trusts', async () => {
    const transport: Transport = async (url) => {
      if (url.includes('company_tickers')) {
        return new Response(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [['999999', 'S000000001', 'C000000001', 'SPUS']] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    expect(await createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, () => {})('SPUS', null)).toBeNull();
  });
});
