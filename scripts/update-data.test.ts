/// <reference types="bun" />
/**
 * Offline tests for the SP Funds feed updater. Every sample is a small inline
 * excerpt in the shape the real pages and feeds use; no test performs network I/O.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_NAMES, HISTORY_HEADERS, HOLDINGS_HEADERS, SEC_UA_DEFAULT, SPFUNDS_TRUST, TIDAL_TRUST, USAGE,
  annualizedFromCumulative, batchSelection, buildCatalog, buildCatalogIndex, yahooHeaders,
  buildPages, catalogIndexEntry, createEdgarFallback, createRequestGate, createTransport,
  cumulativeFromAnnualized, deriveMetrics, performanceAsOf, edgarSeriesFilingsUrl, errorMessage, fillNportTickers,
  formatAumDisplay, formatMoneyText, formatPercentText, formatUsDate, fundFilterReasons, fundPageUrl,
  holdingsCsvUrl, inferDistributionFrequency, lookupPattern, matchesNportFund,
  matchesRange, mergeDividends, nameValueMap, normalizeHoldingName, normalizeWeightText, nportUrlFor, parseMoneyNumber,
  numberOrNull, outputClean, outputConfigEntries, outputCount, outputCreateReporter, outputFundLine,
  outputMoney, outputPrintConfig, outputPrintFilter, outputScalar, pageFileName, parseAumRange, parseCatalogCards,
  parseCatalogMenu, parseCompanyTickerMap, parseCsv, parseEdgarAtomFilings, parseFundPage,
  parseFundTickerMap, parseHtmlTables, parseNport, parseNportAccessions, parseRange, parseSpFundsHoldingsCsv,
  parseYahooChart, paymentsPerYear, periodKey, readConfig, readCursor, readPreviousIndex, readPreviousPages,
  resolveControls, round, runUpdater, runtimeControls, samePublishedContent, sanitizeTicker, secHeaders,
  selectionEntryFromIndex, splitPages, spFundsAssetCategory, stableStringify, toIsoDate, trustForTicker,
  installSystemCa, isCertError, updateFund, writeIfChanged, writePages, writeCursor, yahooChartUrl,
  type CatalogFund, type FundOutcome, type JsonRecord, type SheetRow, type Transport, type UpdaterConfig,
} from './update-data';

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
  return new URL(`file://${dir}/api/spfunds/`);
}

const offlineConfig = (overrides: Record<string, string> = {}): UpdaterConfig =>
  readConfig({ TICKERS: TICKERS.join(' '), REQUEST_SLEEP: '0', CONCURRENCY: '4', SEC_UA: 'tests', ...overrides });

const fundFor = (ticker: string): CatalogFund => ({
  ticker, name: null, category: null, fundPage: fundPageUrl(ticker), inceptionDate: null,
  terValue: null, netTerValue: null, aumValue: null, officialReturns: { asOfDate: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
});

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Numeric and date parsing
// ---------------------------------------------------------------------------

describe('numeric and date parsing', () => {
  test('retains zero, negatives, parentheses, currency and percentages; rejects placeholders', () => {
    // '$3.28B' keeps its suffix (only range parsing understands K/M/B/T).
    expect(['0', 0, '-1.25%', '($1,234.5)', ' $2,500.25 ', '$59.54', '$3.28B', null, undefined, '', ' ', '—', '–', '--', 'N/A', 'garbage'].map(numberOrNull))
      .toEqual([0, 0, -1.25, -1234.5, 2500.25, 59.54, null, null, null, null, null, null, null, null, null, null]);
  });

  test('fund-page, ISO and written dates normalise to UTC; impossible dates are rejected', () => {
    expect(toIsoDate('10/01/2026')).toBe('2026-10-01');
    expect(toIsoDate('09/30/2026')).toBe('2026-09-30');
    expect(toIsoDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    expect(toIsoDate('Oct 1 2026')).toBe('2026-10-01');
    expect(toIsoDate('12/17/2019')).toBe('2019-12-17');
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('—')).toBeNull();
    expect(formatUsDate('10/1/2026')).toBe('Oct 1 2026');
    expect(formatUsDate('nope')).toBeNull();
  });

  test('display helpers keep the published precision of weights and money', () => {
    expect(normalizeWeightText('14.14%')).toBe('14.14%');
    expect(normalizeWeightText('3.64698555')).toBe('3.64698555%');
    expect(normalizeWeightText('-2.12%')).toBe('-2.12%');
    expect(normalizeWeightText('')).toBe('');
    expect(formatMoneyText(464404792.12)).toBe('$464404792.12');
    expect(formatMoneyText(null)).toBe('—');
    expect(formatPercentText(0.524, 2)).toBe('0.52%');
    expect(formatAumDisplay(3283824025)).toBe('$3.28B');
    expect(formatAumDisplay(198_590_000)).toBe('$198.59M');
    expect(round(0.5249999, 2)).toBe(0.52);
  });

  test('catalog and quoting helpers', () => {
    expect(sanitizeTicker(' spus ')).toBe('SPUS');
    expect(sanitizeTicker('BRK.B')).toBe('BRKB');
    expect(parseFundPage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('official catalog', () => {
  test('the Our ETFs submenu yields exactly the five SP Funds ETFs, alphabetically', () => {
    const catalog = buildCatalog(HOME_HTML, []);
    expect(catalog.map((fund) => fund.ticker)).toEqual(TICKERS);
    expect(catalog.every((fund) => fund.fundPage.startsWith('https://www.sp-funds.com/'))).toBe(true);
  });

  test('the menu link wins over a homepage card that points at a section page', () => {
    expect(buildCatalog(HOME_HTML, []).find((fund) => fund.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    // Cards may use absolute links (the current homepage) or relative ones.
    const cards = parseCatalogCards(HOME_HTML);
    expect(cards.find((card) => card.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(cards.find((card) => card.ticker === 'SPUS')!.fundPage).toBe('https://www.sp-funds.com/spus/');
    const synthetic = `<li><a href="#"><span>Our ETFs</span></a><ul class="sub-menu"><li><a href="/spre/"><span>SPRE</span></a></li></ul></li>
      <div class="bdt-ep-advanced-icon-box-content"><h3 class="bdt-ep-advanced-icon-box-title"><span>SPRE</span></h3>
      <a class="bdt-ep-advanced-icon-box-readmore" href="/spre-2/">See Details</a></div>`;
    expect(parseCatalogCards(synthetic)[0].fundPage).toBe('https://www.sp-funds.com/spre-2/');
    expect(buildCatalog(synthetic, [])[0].fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(buildCatalog('<p>no cards</p>', ['SPUS', 'SPWO']).map((fund) => fund.fundPage))
      .toEqual(['https://www.sp-funds.com/spus/', 'https://www.sp-funds.com/spwo/']);
  });

  test('menu parsing ignores non-fund links', () => {
    const withTargetDate = HOME_HTML.replace('</ul></li>', '</ul></li><li><a href="#"><span>Target Date Funds</span></a><ul class="sub-menu"><li><a href="/sptax/"><span>SPTAX</span></a></li></ul></li>');
    const cards = parseCatalogMenu(withTargetDate);
    expect(cards.map((card) => card.ticker)).not.toContain('SPTAX');
    expect(cards.length).toBe(5);
    expect(parseCatalogCards(HOME_HTML).map((card) => card.ticker).sort()).toEqual(TICKERS);
  });

  test('an explicit TICKERS selection narrows and extends the catalog, unknown markup falls back to the known lineup', () => {
    expect(buildCatalog(HOME_HTML, ['SPUS', 'SPWO']).map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    const extra = buildCatalog(HOME_HTML, ['SPUS', 'ZZZZ']);
    expect(extra.map((fund) => fund.ticker)).toEqual(['SPUS', 'ZZZZ']);
    expect(extra.find((fund) => fund.ticker === 'ZZZZ')!.fundPage).toBe('https://www.sp-funds.com/zzzz/');
    expect(buildCatalog('<html>redesigned</html>', []).map((fund) => fund.ticker)).toEqual(TICKERS);
  });
});

// ---------------------------------------------------------------------------
// Fund pages
// ---------------------------------------------------------------------------

describe('official fund pages', () => {
  const page = parseFundPage(fundPageHtml('SPUS'), 'SPUS');

  test('SPUS: official legal name, identifiers and pricing from the two-column tables', () => {
    expect(page.name).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(lookupPattern(page.details, /fund inception/i)).toBe('12/17/2019');
    expect(lookupPattern(page.details, /cusip/i)).toBe('886364801');
    expect(lookupPattern(page.details, /primary exchange/i)).toBe('NYSE');
    expect(lookupPattern(page.details, /expense ratio/i)).toBe('0.45%');
    expect(lookupPattern(page.details, /sec yield/i)).toBe('0.40%');
    expect(lookupPattern(page.pricing, /net assets/i)).toBe('$3274.89m');
    expect(lookupPattern(page.pricing, /^nav$/i)).toBe('$59.54');
    expect(parseMoneyNumber('$3274.89m')).toBe(3274890000);
    expect(parseMoneyNumber('$59.54')).toBe(59.54);
    expect(parseMoneyNumber('')).toBeNull();
    expect(lookupPattern(page.pricing, /shares outstanding/i)).toBe('55,000,000');
    expect(parseMoneyNumber('55,000,000')).toBe(55000000);
    expect(lookupPattern(page.pricing, /premium\/?discount/i)).toBe('-0.01%');
    expect(lookupPattern(page.pricing, /closing price/i)).toBe('$59.54');
    expect(page.pricingAsOf).toBe('2026-09-30');
  });

  test('SPUS: month-end NAV returns, benchmark and document tiles', () => {
    expect(page.monthEnd!.tickerRow).toBe('SPUS NAV');
    expect(page.monthEnd!.returns).toEqual({
      asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57,
    });
    expect(page.quarterEnd!.returns).toEqual(page.monthEnd!.returns);
    expect(page.benchmark).toBe('SPSIEUT');
    expect(page.benchmarkName).toBe('S&P 500 Shariah Industry Exclusions Index (USD) TR');
    expect(page.documents['prospectus']).toContain('spfunds-PRO_032626_web.pdf');
    expect(page.documents['summaryProspectus']).toContain('spus-497k_033026.pdf');
    expect(page.documents['sai']).toContain('spfunds-SAI_032626_web.pdf');
    expect(page.documents['factsheet']).toContain('SPUS-Factsheet-2026-Q2.pdf');
    expect(page.holdingsCsvUrl).toBe(holdingsCsvUrl('SPUS'));
  });

  test('SPUS: the distribution calendar keeps the published ex/record/payable dates', () => {
    expect(page.distributions.length).toBe(6);
    expect(page.distributions[0]).toEqual({ exDate: '2026-09-28', recordDate: '2026-09-28', payDate: '2026-09-29', amount: 0.026 });
    expect(page.distributions[1].exDate).toBe('2026-08-26');
    expect(page.distributions.every((row) => row.amount !== null)).toBe(true);
  });

  test('SPTE: month-end and quarter-end tables differ and a young fund keeps its published zero', () => {
    const spte = parseFundPage(fundPageHtml('SPTE'), 'SPTE');
    expect(spte.name).toBe('SP Funds S&P Global Technology ETF');
    expect(spte.monthEnd!.returns.asOfDate).toBe('2026-08-31');
    expect(spte.monthEnd!.returns.ytd).toBe(34.78);
    expect(spte.quarterEnd!.returns.asOfDate).toBe('2026-06-30');
    expect(spte.quarterEnd!.returns.ytd).toBe(38.73);
    // Published as 0.00 because the fund is younger than three years: not null.
    expect(spte.monthEnd!.returns.yr3).toBe(0);
    expect(spte.monthEnd!.returns.yr5).toBeNull();
    expect(spte.documents['prospectus']).toContain('spfunds-485bpos_022626-PRO-SPTE.pdf');
  });

  test('every sample fund page parses without an empty identity', () => {
    for (const ticker of TICKERS) {
      const parsed = parseFundPage(fundPageHtml(ticker), ticker);
      expect(parsed.name, ticker).toBeTruthy();
      expect(parsed.monthEnd, ticker).not.toBeNull();
      expect(lookupPattern(parsed.details, /cusip/i), ticker).toMatch(/^[0-9A-Z]{9}$/);
    }
    expect(trustForTicker('SPUS')).toBe(TIDAL_TRUST);
    expect(trustForTicker('SPWO')).toBe(SPFUNDS_TRUST);
  });

  test('generic HTML table helpers keep row/column shape', () => {
    const tables = parseHtmlTables('<table id="x"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(tables).toEqual([{ start: 0, id: 'x', headers: ['A', 'B'], rows: [['1', '2']] }]);
    const map = nameValueMap([['Net Assets', '$3.28B'], ['Net Assets', 'ignored'], ['Name', '']]);
    expect(map.get('Net Assets')).toBe('$3.28B');
  });
});

// ---------------------------------------------------------------------------
// Official daily holdings CSV
// ---------------------------------------------------------------------------

describe('official holdings CSV', () => {
  const parsed = parseSpFundsHoldingsCsv(holdingsCsv('SPUS'));

  test('SPUS: positions map onto the shared holdings contract', () => {
    expect(parsed.headers).toEqual(HOLDINGS_HEADERS);
    expect(parsed.rows.length).toBe(6);
    expect(parsed.asOfDate).toBe('2026-10-01');
    expect(parsed.netAssets).toBe(3283824025);
    expect(parsed.sharesOutstanding).toBe(55150000);
    expect(parsed.rows[0]).toEqual({
      Name: 'NVIDIA Corp', Ticker: 'NVDA', Identifier: '67066G104', Weight: '14.14%',
      'Market Value': '$464404792.12', 'Shares Held': '2033474', 'Asset Category': 'Equity',
    });
    expect(parsed.rows[1].Ticker).toBe('AAPL');
    expect(parsed.rows.every((row) => Object.keys(row).length === HOLDINGS_HEADERS.length)).toBe(true);
  });

  test('cash balances, currency lines, funds and options are categorised from the row itself', () => {
    expect(spFundsAssetCategory('Cash&Other', 'Cash & Other')).toBe('Cash');
    expect(spFundsAssetCategory('', 'US Treasury Bill')).toBe('Fixed Income');
    expect(spFundsAssetCategory('SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF')).toBe('Fund');
    expect(spFundsAssetCategory('WELL', 'Welltower Inc')).toBe('Equity');
    expect(spFundsAssetCategory('SPXW 261001P07075000', 'SPXW Oct 2026 7075 Put')).toBe('Option');
  });

  test('the SPRE cash cushion keeps the provider negative value', () => {
    const spre = parseSpFundsHoldingsCsv(holdingsCsv('SPRE'));
    const cash = spre.rows.find((row) => row['Asset Category'] === 'Cash')!;
    expect(cash.Ticker).toBe('Cash&Other');
    expect(Number(cash.Weight.replace('%', ''))).toBeLessThan(0);
    expect(spre.rows.some((row) => / AU$/.test(row.Ticker))).toBe(true);
  });

  test('quoting, BOM, CRLF and truncated files are handled without inventing rows', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y",2,"say ""hi"""\r\n1,2,3\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', '2', 'say "hi"'], ['1', '2', '3']]);
    expect(parseSpFundsHoldingsCsv('').rows).toEqual([]);
    expect(() => parseSpFundsHoldingsCsv('Date,Weird\n1,2\n')).toThrow('StockTicker');
    // A truncated download must not turn the partial tail into a position.
    const truncated = holdingsCsv('SPUS').split('\n').slice(0, 4).join('\n');
    expect(parseSpFundsHoldingsCsv(truncated).rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Yahoo Finance
// ---------------------------------------------------------------------------

describe('Yahoo chart feed', () => {
  const chart = parseYahooChart(JSON.parse(yahooJson('SPUS')));

  test('SPUS: whole daily series, newest first, adjusted closes rounded to cents', () => {
    expect(chart.days.length).toBe(30);
    expect(chart.days[0].date >= chart.days[1].date).toBe(true);
    expect(chart.days.every((day) => Number(day.close.toFixed(2)) === day.close && Number(day.adjClose.toFixed(2)) === day.adjClose)).toBe(true);
    expect(chart.days.some((day) => day.volume > 0)).toBe(true);
    // Yahoo reports the first trading day, the fund page the inception date.
    expect(chart.firstTradeDate).toBe('2019-12-18');
    expect(chart.exchange).toBe('NYSEArca');
  });

  test('dividends are newest first and keep Yahoo epochs', () => {
    expect(chart.dividends.length).toBe(2);
    expect(chart.dividends[0].exDate >= chart.dividends[1].exDate).toBe(true);
    expect(chart.dividends[0].amount).toBe(0.026);
  });

  test('an empty chart result fails instead of pretending an empty history', () => {
    expect(() => parseYahooChart({ chart: { result: null } })).toThrow('empty result');
    expect(() => parseYahooChart({})).toThrow('empty result');
  });

  test('official distribution dates win over Yahoo when the calendar already lists them', () => {
    const official = [{ exDate: '2026-09-28', recordDate: '2026-09-28', payDate: '2026-09-29', amount: 0.026 }];
    const merged = mergeDividends(official, [
      { epoch: 1, amount: 0.026, exDate: '2026-09-28', recordDate: null, payDate: null },
      { epoch: 2, amount: 0.02, exDate: '2026-08-26', recordDate: null, payDate: null },
    ]);
    expect(merged.map((row) => row.exDate)).toEqual(['2026-09-28', '2026-08-26']);
    expect(merged[0].payDate).toBe('2026-09-29');
  });

  test('HISTORY_RANGE limits the request window through explicit period1/period2', () => {
    const now = Date.UTC(2026, 9, 1);
    const seconds = Math.floor(now / 1000);
    const start = (url: string): number => Number(new URL(url).searchParams.get('period1'));
    expect(start(yahooChartUrl('SPUS', 'max', now))).toBe(0);
    expect(start(yahooChartUrl('SPUS', '5y', now))).toBe(Math.floor(seconds - 5 * 365.25 * 86_400));
    expect(start(yahooChartUrl('SPUS', '5y', now))).toBeGreaterThan(start(yahooChartUrl('SPUS', '10y', now)));
    expect(new URL(yahooChartUrl('SPUS', '5y', now)).searchParams.get('period2')).toBe(String(seconds));
    expect(new URL(yahooChartUrl('SPUS', '5y', now)).searchParams.has('range')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('derived metrics', () => {
  const official = { asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 };

  test('cumulative total return and CAGR invert each other', () => {
    expect(cumulativeFromAnnualized(25.32, 3)).toBe(96.82);
    expect(annualizedFromCumulative(96.82, 3)).toBe(25.32);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-101, 3)).toBeNull();
    expect(cumulativeFromAnnualized(21.21, 1)).toBe(21.21);
  });

  test('official month-end returns are published as-is; only cumulative figures are derived', () => {
    const metrics = deriveMetrics(official, 'Monthly', 0.026, 59.54, 0.4);
    expect(metrics.ytd).toBe(17.13);
    expect(metrics.tr1y).toBe(21.21);
    expect(metrics.tr3y).toBe(96.82);
    expect(metrics.tr5y).toBe(113.41);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.cagr3y).toBe(25.32);
    expect(metrics.siAnn).toBe(18.57);
    expect(metrics.dividendYield).toBe(0.52);
    expect(metrics.dividendYieldText).toBe('0.52%');
    expect(metrics.secYieldText).toBe('0.40%');
    expect(metrics.returnsBasis).toContain('official SP Funds month-end NAV total returns');
    expect(metrics.performanceAsOf).toBe('2026-09-30');
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
  });

  test('performanceAsOf is the performance table date, null when unknown, never empty', () => {
    expect(performanceAsOf({ ...official, asOfDate: '2026-08-31' })).toBe('2026-08-31');
    expect(performanceAsOf({ ...official, asOfDate: null })).toBeNull();
    expect(performanceAsOf({ ...official, asOfDate: '' })).toBeNull();
    expect(deriveMetrics({ ...official, asOfDate: null }, 'Monthly', 0.026, 59.54, 0.4).performanceAsOf).toBeNull();
    expect(deriveMetrics(official, 'Monthly', 0.026, 59.54, 0.4).returnsBasis.trim()).not.toBe('');
  });

  test('a missing yield or frequency never fabricates a number', () => {
    const metrics = deriveMetrics(official, null, 0.026, 59.54, null);
    expect(metrics.dividendYield).toBeNull();
    expect(metrics.dividendYieldText).toBe('—');
    expect(metrics.secYieldText).toBe('—');
    expect(deriveMetrics(official, 'Monthly', 0.026, 0, 0.4).dividendYield).toBeNull();
  });

  test('frequency is derived only from the fund own published ex-dates', () => {
    expect(paymentsPerYear('Monthly')).toBe(12);
    expect(paymentsPerYear('Quarterly')).toBe(4);
    expect(paymentsPerYear('Semi-annually')).toBe(6);
    expect(paymentsPerYear('Annually')).toBe(1);
    expect(paymentsPerYear('')).toBeNull();
    const monthly = ['2026-09-28', '2026-08-26', '2026-07-27', '2026-06-26', '2026-05-27', '2026-04-27'];
    expect(inferDistributionFrequency(monthly, new Date('2026-10-01T00:00:00Z'))).toBe('Monthly');
    expect(inferDistributionFrequency(['2026-09-28', '2026-06-26'], new Date('2026-10-01T00:00:00Z'))).toBeNull();
    expect(inferDistributionFrequency([], new Date('2026-10-01T00:00:00Z'))).toBeNull();
    expect(inferDistributionFrequency(['2020-01-01', '2020-02-01', '2020-03-01'], new Date('2026-10-01T00:00:00Z'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));

  test('the checked-in JSON holds exactly the canonical controls with the provider defaults', () => {
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(file).every((value) => typeof value === 'string')).toBe(true);
    expect(file['MAX_FETCHES']).toBe('0');
    expect(file['CONCURRENCY']).toBe('2');
    expect(file['REQUEST_SLEEP']).toBe('1');
    expect(file['SEC_UA']).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(SEC_UA_DEFAULT).toBe(file['SEC_UA']);
    const config = readConfig(resolveControls(file));
    expect(config.tickers).toEqual([]);
    expect(config.maxRetries).toBe(2);
    expect(config.historyRange).toBe('max');
    expect(config.edgarFallback).toBe(true);
    expect(config.skipSpFunds).toBe(false);
    expect(config.skipYahoo).toBe(false);
    expect(config.aumRange).toBeUndefined(); // ":" disables
    expect(config.performanceRanges).toEqual({});
    expect(config.secUa).toBe(SEC_UA_DEFAULT);
  });

  test('precedence: file < advanced < nonblank input < environment, blank input inherits', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPUS' }, { CONCURRENCY: 3, TICKERS: 'SPRE' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect(c['CONCURRENCY']).toBe('5');
    expect(c['TICKERS']).toBe('SPRE'); // blank input does not clear the advanced value
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    // advanced may deliberately set a key to an empty string
    expect(resolveControls({ TICKERS: 'SPUS' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    // an explicitly set environment variable wins even when empty
    expect(resolveControls({ TICKERS: 'SPUS' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({}, {}, {}, { SKIP_SP_FUNDS: 'true' }).SKIP_SPFUNDS).toBe('true');
    // unrelated environment variables are ignored
    expect(resolveControls(file, {}, {}, { PATH: '/bin', HOME: '/root' })).toEqual(resolveControls(file));
  });

  test('the scheduled path (empty inputs and advanced) equals the config defaults', () => {
    const scheduled = resolveControls(file, JSON.parse('{}'), { TICKERS: '', MAX_FETCHES: '' }, {});
    expect(scheduled).toEqual(resolveControls(file));
    for (const [key, value] of Object.entries(file)) expect(scheduled[key]).toBe(value as string);
  });

  test('the resolver rejects unknown keys, non-scalars, newlines and invalid values', () => {
    const invalid: unknown[] = [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\0y' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 },
      { MAX_FETCHES: 1.5 }, { MAX_FETCHES: '-1' }, { REQUEST_SLEEP: '-1' }, { REQUEST_SLEEP: 'fast' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' },
      { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: '2' }, { AUM: '1:2:3' }, { AUM: 'huge' }, { AUM: '5B:1B' }, { TER: 'a:b' }, { TER: '2' },
      { PERFORMANCE_1Y: '10:0' }, { TOTAL_RETURN_YTD: ':x' }, { HISTORY_RANGE: '1mo' }, { HISTORY_RANGE: '0y' }, { HOLDINGS_PAGE_SIZE: 0 },
      { HISTORY_PAGE_SIZE: 'big' }, { TICKERS: ['SPUS'] }, { TICKERS: { a: 1 } }, null, [], 'text',
    ];
    for (const value of invalid) expect(() => resolveControls(value), JSON.stringify(value)).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, null)).toThrow();
    expect(() => resolveControls({}, {}, { CONCURRENCY: 'x\n1' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'a\nb' })).toThrow();
    expect(() => resolveControls({}, {}, { UNKNOWN: 'x' })).toThrow('Unknown updater control');
  });

  test('runtimeControls reads the checked-in file and lets the environment win', async () => {
    expect(await runtimeControls({})).toEqual(resolveControls(file));
    const controls = await runtimeControls({ TICKERS: 'SPUS SPWO', MAX_RETRIES: '3', SEC_UA: '' });
    expect(controls['TICKERS']).toBe('SPUS SPWO');
    expect(readConfig(controls).maxRetries).toBe(3);
    expect(readConfig(controls).tickers).toEqual(['SPUS', 'SPWO']);
    // an explicitly empty SEC_UA clears the control; the code default still identifies the feed
    expect(controls['SEC_UA']).toBe('');
    expect(readConfig(controls).secUa).toBe(SEC_UA_DEFAULT);
  });

  test('valid values are typed; zero and false are honoured', () => {
    const config = readConfig({ MAX_FETCHES: '0', REQUEST_SLEEP: '0', SKIP_YAHOO: 'false', EDGAR_FALLBACK: '0', MAX_RETRIES: '1', HISTORY_RANGE: '5Y', TICKERS: 'spus;spwo, spre' });
    expect(config.maxFetches).toBe(0);
    expect(config.requestSleep).toBe(0);
    expect(config.skipYahoo).toBe(false);
    expect(config.edgarFallback).toBe(false);
    expect(config.maxRetries).toBe(1);
    expect(config.historyRange).toBe('5y');
    expect(config.tickers).toEqual(['SPUS', 'SPWO', 'SPRE']);
    expect(readConfig({ REQUEST_SLEEP: '0.5' }).requestSleep).toBe(0.5);
    expect(readConfig({ CONCURRENCY: '15' }).concurrency).toBe(15);
  });

  test('ranges and AUM presets', () => {
    expect(parseRange('1:5')).toEqual({ min: 1, max: 5 });
    expect(parseRange(':5')).toEqual({ min: -Infinity, max: 5 });
    expect(parseRange('2:')).toEqual({ min: 2, max: Infinity });
    expect(parseRange('-5:5')).toEqual({ min: -5, max: 5 });
    expect(parseRange(':')).toBeUndefined();
    expect(parseRange('')).toBeUndefined();
    expect(() => parseRange('nonsense')).toThrow();
    expect(parseAumRange('mid')).toEqual({ min: 2e9, max: 1e10, source: 'mid' });
    expect(parseAumRange('500M:2B')).toEqual({ min: 5e8, max: 2e9, source: '500M:2B' });
    const config = readConfig({ AUM: '1B:', TER: '0:0.5', PERFORMANCE_1Y: '0:100', TOTAL_RETURN_3Y: ':', SEC_YIELD: '0.4:5' });
    expect(config.aumRange!.min).toBe(1e9);
    expect(config.terRange!.max).toBe(0.5);
    expect(config.performanceRanges['1Y']).toEqual({ min: 0, max: 100 });
    expect(config.totalReturnRanges['3Y']).toBeUndefined();
    expect(config.secYieldRange!.min).toBe(0.4);
  });

  test('--help, README controls table, config file and CONTROL_NAMES stay in sync', () => {
    const doc = read('README.md');
    const section = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
    for (const name of CONTROL_NAMES) {
      expect(section, name).toContain(`| \`${name}\` |`);
      expect(USAGE, name).toContain(name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '_<P>'));
    }
    const rows = [...section.matchAll(/^\| `([A-Z_0-9]+)`/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual([...CONTROL_NAMES].sort());
    expect(doc).toContain('scripts/update-data.config.json');
    expect(doc).toContain(SEC_UA_DEFAULT);
  });
});

describe('system CA support', () => {
  test('USE_SYSTEM_CA resolves case-insensitively, defaults to auto and rejects other values', () => {
    const file = JSON.parse(readFileSync(new URL('./update-data.config.json', import.meta.url), 'utf8'));
    expect(file.USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(() => readConfig(resolveControls(file, {}, {}, { USE_SYSTEM_CA: value }))).not.toThrow();
    }
    expect(() => resolveControls(file, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(() => readConfig({ USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
  });

  test('isCertError detects untrusted-certificate errors, also through cause', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa leaves fetch alone for false or an active store, restarts for true, wraps fetch for auto', async () => {
    const original = globalThis.fetch;
    const never = (): never => { throw new Error('unexpected reexec'); };
    try {
      installSystemCa('false', never, false);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('auto', never, true);
      expect(globalThis.fetch).toBe(original);

      let calls = 0;
      expect(() => installSystemCa('true', (() => { calls++; throw new Error('reexec'); }) as () => never, false)).toThrow('reexec');
      expect(calls).toBe(1);
      expect(globalThis.fetch).toBe(original);

      let reexecs = 0;
      const reexec = (): never => { reexecs++; throw new Error('reexec'); };
      let next: () => Promise<Response> = async () => new Response('ok');
      globalThis.fetch = (async () => next()) as unknown as typeof fetch;
      const stub = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(stub);
      expect(await (await fetch('https://example.test/')).text()).toBe('ok');
      expect(reexecs).toBe(0);
      next = async () => { throw new Error('HTTP 403'); };
      await expect(fetch('https://example.test/')).rejects.toThrow('HTTP 403');
      expect(reexecs).toBe(0);
      next = async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); };
      await expect(fetch('https://example.test/')).rejects.toThrow('reexec');
      expect(reexecs).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('repository contract', () => {
  const source = read('scripts/update-data.ts');
  const workflow = read('.github/workflows/update-data.yml');

  test('scripts/ holds exactly the three standard files and the updater is directly executable', () => {
    expect(readdirSync(new URL('./', import.meta.url)).sort()).toEqual(['update-data.config.json', 'update-data.test.ts', 'update-data.ts']);
    const lines = source.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bun');
    expect(lines[1]).toBe('/// <reference types="bun" />');
    expect(statSync(new URL('./update-data.ts', import.meta.url)).mode & 0o111).not.toBe(0);
    expect(source).not.toContain('example.com');
    expect(source).not.toMatch(/worklog|\.prompt\.txt/);
  });

  test('the workflow is the generated template: scheduled, <= 25 inputs, advanced JSON, fixed output dir', () => {
    const parsed = (Bun as unknown as { YAML: { parse(text: string): Record<string, any> } }).YAML.parse(workflow);
    const inputs = parsed['on']['workflow_dispatch']['inputs'] as Record<string, { default: string; type: string }>;
    const names = Object.keys(inputs);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(inputs['advanced'].default).toBe('{}');
    for (const name of names.filter((value) => value !== 'advanced')) {
      expect(CONTROL_NAMES as readonly string[], name).toContain(name.toUpperCase());
      expect(inputs[name].default).toBe('');
    }
    // every control is reachable: individually, or through the advanced JSON
    expect(CONTROL_NAMES.length).toBeGreaterThan(names.length - 1);
    expect(parsed['on']['schedule'][0]['cron']).toBe('0 0 * * 0');
    expect(parsed['permissions']['contents']).toBe('write');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('toJSON(inputs)');
    expect(workflow).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(workflow).not.toMatch(/\$\{\{\s*inputs\./);
    expect(workflow).not.toMatch(/OUTPUT_DIR|OUT_DIR/);
    expect(workflow).toContain('git add api/spfunds\n');
    expect(workflow.match(/git add /g)!.length).toBe(1);
    expect(workflow.indexOf('bun test')).toBeLessThan(workflow.indexOf('bun ./scripts/update-data.ts'));
    expect(readdirSync(new URL('../.github/workflows/', import.meta.url))).toEqual(['update-data.yml']);
  });

  test('the updater only ever writes below api/spfunds', () => {
    expect(source).toMatch(/new URL\('\.\.\/api\/spfunds\/', import\.meta\.url\)/);
    expect(source).not.toMatch(/OUTPUT_DIR/);
  });

  test('the README follows the standard section order and omits retired artifacts', () => {
    const doc = read('README.md');
    const order = ['## Using Bun', '## Updating the static SP Funds data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
    let last = -1;
    for (const heading of order) {
      const index = doc.indexOf(`\n${heading}\n`);
      expect(index, heading).toBeGreaterThan(last);
      last = index;
    }
    for (const retired of ['worklog', '.prompt', 'evidence', 'fixtures', 'research/', 'app-contract']) expect(doc.toLowerCase(), retired).not.toContain(retired);
    for (const command of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) {
      expect(doc).toContain(command);
    }
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('selection and batching', () => {
  test('range matching distinguishes true zero from missing data', () => {
    expect(matchesRange(0, { min: 0, max: 1 })).toBe(true);
    expect(matchesRange(0, { min: 0.1, max: 1 })).toBe(false);
    expect(matchesRange(null, { min: 0, max: 1 })).toBe(false);
    expect(matchesRange(null, undefined)).toBe(true);
    expect(matchesRange(0.4, undefined)).toBe(true);
  });

  test('filters AND together and report every failing dimension', () => {
    const config = readConfig({ AUM: '1B:', TER: '0:0.5', PERFORMANCE_1Y: '0:20' });
    const entry = {
      ticker: 'SPUS', aumValue: 3.28e9, terValue: 0.45, secYield: 0.4, dividendYield: 0.52,
      returns: { asOfDate: null, ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 },
      metrics: null,
    };
    expect(fundFilterReasons(entry, config)).toEqual(['performance_1y']);
    expect(fundFilterReasons({ ...entry, aumValue: 1e8, terValue: 0.9 }, config)).toEqual(['aum', 'ter', 'performance_1y']);
    expect(fundFilterReasons(entry, readConfig({}))).toEqual([]);
  });

  test('published facts feed the filters; a fund without a published entry is always kept', () => {
    const entry = {
      ticker: 'SPUS', aumValue: 3.28e9, terValue: 0.45,
      returns: { monthEnd: { asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 } },
      metrics: { dividendYield: 0.52, secYield: 0.4, tr3y: 96.82 },
    };
    const selection = selectionEntryFromIndex(entry)!;
    expect(selection.returns.yr1).toBe(21.21);
    expect(selection.aumValue).toBe(3.28e9);
    expect(selection.metrics!.secYield).toBe(0.4);
    expect(selectionEntryFromIndex(undefined)).toBeNull();
    expect(periodKey('YTD')).toBe('ytd');
    expect(periodKey('10Y')).toBe('yr10');
  });

  test('bounded runs rotate deterministically and never mutate the catalog', () => {
    const catalog = buildCatalog(HOME_HTML, []);
    const all = batchSelection(catalog, 0, 'SPTE');
    expect(all.map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
    const bounded = batchSelection(catalog, 2, 'SPTE');
    expect(bounded.map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    expect(batchSelection(catalog, 3, null).map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE']);
    // The worker pool shifts the batch: the catalog itself must survive.
    bounded.splice(0, bounded.length);
    expect(catalog.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Console contract, writes and pages
// ---------------------------------------------------------------------------

describe('console contract', () => {
  test('the bracket, ticker and status keep the shared padding', () => {
    const line = outputFundLine(1, 5, 'SPUS', 'ok', { history: 356, holdings: 219, distributions: 39, netAssets: 3283824025, dividendYield: '0.52%', secYield: '0.40%' });
    expect(line.startsWith('[  1/5   ] SPUS  ok')).toBe(true);
    expect(line).toContain('history=356');
    expect(line).toContain('holdings=219');
    expect(line).toContain('divs=39');
    expect(line).toContain('netAssets=$3.3B');
    expect(line).toContain('div=0.52%');
    expect(line).toContain('sec=0.40%');
    // The status column is nine characters wide, and longer totals widen the index column.
    expect(outputFundLine(1, 5, 'SPUS', 'updated', {})).toContain('] SPUS  updated');
    expect(outputFundLine(3, 12, 'SPWO', 'unchanged', {}).startsWith('[  3/12  ] SPWO  unchanged')).toBe(true);
  });

  test('null-ish fields are omitted, zero and false are preserved, long reasons are flattened', () => {
    const line = outputFundLine(2, 5, 'SPRE', 'failed', { history: 0, holdings: null }, 'retained: holdings\nissuer page');
    expect(line).toContain('history=0');
    expect(line).not.toContain('holdings=');
    expect(line).toContain('reason=retained: holdings issuer page');
    expect(line.includes('\n')).toBe(false);
    expect(outputCount([])).toBe(0);
    expect(outputCount({ totalRows: 400 })).toBe(400);
    expect(outputCount({ rows: [[1], [2]] })).toBe(2);
    expect(outputScalar({ display: '$3.28B' })).toBe('$3.28B');
    expect(outputMoney(453_000_000)).toBe('$453.0M');
    expect(outputMoney('$3.28B')).toBe('$3.3B');
    expect(outputMoney(null)).toBe('null');
    expect(outputMoney('—')).toBe('null');
    expect(outputClean('a\tb\nc')).toBe('a b c');
  });

  test('the reporter numbers the processed funds in order', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { lines.push(String(value)); };
    try {
      const reporter = outputCreateReporter(2);
      reporter.result('SPUS', 'updated', { holdings: 40 });
      reporter.result('SPWO', 'unchanged', { holdings: 40 });
    } finally {
      console.log = original;
    }
    expect(lines[0].startsWith('[  1/2   ] SPUS  updated')).toBe(true);
    expect(lines[1].startsWith('[  2/2   ] SPWO  unchanged')).toBe(true);
  });

  test('config output prints canonical names, redacts secrets and is stable', () => {
    const config = readConfig(resolveControls(JSON.parse(read('scripts/update-data.config.json'))));
    const entries = outputConfigEntries(config as unknown as JsonRecord);
    expect(entries.map(([key]) => key).slice(0, 3)).toEqual(['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY']);
    const names = entries.map(([key]) => key);
    for (const expected of ['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_YTD', 'PERFORMANCE_10Y', 'TOTAL_RETURN_YTD', 'SKIP_SPFUNDS', 'HISTORY_RANGE', 'SEC_UA']) {
      expect(names).toContain(expected);
    }
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { lines.push(String(value)); };
    try {
      outputPrintFilter(3, 5);
    } finally {
      console.log = original;
    }
    expect(lines[0]).toBe('[ filter   ] 3 of 5 funds pass filters');
  });

  test('the SEC contact is redacted in the config log', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { lines.push(String(value)); };
    try {
      outputPrintConfig('SP Funds', readConfig({ SEC_UA: 'secret contact' }) as unknown as JsonRecord, {});
    } finally {
      console.log = original;
    }
    expect(lines.join('\n')).toContain('SEC_UA=<redacted>');
    expect(lines.join('\n')).not.toContain('secret contact');
    expect(lines.join('\n')).not.toContain('daggerok@gmail.com');
  });
});

describe('idempotent writers and paged sheets', () => {
  test('recursive run timestamps never cause byte churn; material changes do', () => {
    const published = (generatedAt: string, rows: number) => ({ generatedAt, count: { rows, nested: { generatedAt } }, funds: [{ ticker: 'SPUS', catalogReadAt: 'x' }] });
    expect(samePublishedContent(stableStringify(published('2026-10-01T00:00:00.000Z', 1)), published('2026-10-02T00:00:00.000Z', 1))).toBe(true);
    expect(samePublishedContent(stableStringify(published('2026-10-01T00:00:00.000Z', 1)), published('2026-10-01T00:00:00.000Z', 2))).toBe(false);
    expect(samePublishedContent('not json', published('now', 1))).toBe(false);
    expect(stableStringify({ b: 1 }).endsWith('\n')).toBe(true);
  });

  test('pages split on exact boundaries and skip stale page files', async () => {
    expect(splitPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitPages([], 2)).toEqual([]);
    expect(pageFileName(1)).toBe('001.json');
    expect(pageFileName(12)).toBe('012.json');
    const rows: SheetRow[] = Array.from({ length: 5 }, (_, index) => ({ Name: `n${index}`, Ticker: `T${index}` }));
    const built = buildPages('SPUS', 'holdings', HOLDINGS_HEADERS, rows, 2, '2026-10-01');
    expect(built.map((page) => page.name)).toEqual(['001.json', '002.json', '003.json']);
    expect(built[0].payload['totalRows']).toBe(5);
    expect((built[0].payload['rows'] as SheetRow[])[0]['Name']).toBe('n0');
    expect(built[0].payload['headers']).toEqual(HOLDINGS_HEADERS);

    const dir = await mkdtemp(join(tmpdir(), 'spfunds-pages-'));
    const holdingsDir = new URL(`file://${dir}/holdings/`);
    await writePages(holdingsDir, 'SPUS', 'holdings', HOLDINGS_HEADERS, rows, 2, '2026-10-01');
    expect((await readdir(holdingsDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
    const manifest = await writePages(holdingsDir, 'SPUS', 'holdings', HOLDINGS_HEADERS, rows.slice(0, 2), 2, '2026-10-01');
    expect(manifest.pages).toEqual(['001.json']);
    expect((await readdir(holdingsDir)).sort()).toEqual(['001.json']);
    const previous = await readPreviousPages(holdingsDir, manifest);
    expect(previous.headers).toEqual(HOLDINGS_HEADERS);
    expect(previous.rows.length).toBe(2);
    expect(previous.rows[0]['Name']).toBe('n0');
    expect(previous.rows[0]['Identifier']).toBe('');
    expect(previous.manifest!.totalRows).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  test('writeIfChanged only touches the file when the published content changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spfunds-write-'));
    const file = new URL(`file://${dir}/index.json`);
    expect(await writeIfChanged(file, { generatedAt: 'a', value: 1 })).toBe(true);
    expect(await writeIfChanged(file, { generatedAt: 'b', value: 1 })).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))['generatedAt']).toBe('a');
    expect(await writeIfChanged(file, { generatedAt: 'b', value: 2 })).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Pacing and transport
// ---------------------------------------------------------------------------

describe('pacing, retries and transport', () => {
  test('independent lanes start requests immediately instead of serialising them', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = createRequestGate(2, 1000, () => clock, async (ms: number) => { waits.push(ms); clock += ms; });
    await gate();
    await gate();
    // A single shared lane would have waited here already.
    expect(waits).toEqual([]);
    await gate();
    expect(waits).toEqual([1000]);
    expect(clock).toBe(1000);
  });

  test('retries transient statuses only and reports the final failure', async () => {
    let attempts = 0;
    const fetcher = async (): Promise<Response> => {
      attempts += 1;
      if (attempts < 3) return new Response('busy', { status: 503 });
      return new Response('{"ok":true}', { status: 200 });
    };
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }), async () => {}, fetcher as unknown as typeof fetch, async () => {});
    const response = await transport('https://example.test/a', 'test');
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);

    let permanent = 0;
    const forbidden = createTransport(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }), async () => {}, (async () => { permanent += 1; return new Response('no', { status: 403 }); }) as unknown as typeof fetch, async () => {});
    await expect(forbidden('https://example.test/b', 'test')).rejects.toThrow('HTTP 403');
    expect(permanent).toBe(1);
    expect(errorMessage(new Error('x'))).toBe('x');
  });

  test('SEC and Yahoo headers declare the right identity', () => {
    const config = readConfig({ SEC_UA: 'My Fund Feed me@mail.test' });
    expect(secHeaders(config)['User-Agent']).toBe('My Fund Feed me@mail.test');
    expect(yahooHeaders()['User-Agent']).toContain('Mozilla');
    expect(secHeaders(readConfig({}))['User-Agent']).toBe('daggerok ETF feed daggerok@gmail.com');
  });
});

// ---------------------------------------------------------------------------
// SEC N-PORT-P fallback
// ---------------------------------------------------------------------------

describe('SEC N-PORT-P fallback', () => {
  const seriesPayload = SERIES_PAYLOAD;

  test('the EDGAR fund ticker table maps tickers to registrant, series and class', () => {
    const map = parseFundTickerMap(seriesPayload);
    expect(map.get('SPUS')).toEqual({ cik: '0001742912', seriesId: 'S000070027', classId: 'C000220954' });
    expect(map.get('SPTE')!.cik).toBe('0001989916');
    expect(map.has('SPWO')).toBe(false);
    expect(parseFundTickerMap({ fields: ['symbol', 'cik'], data: [['SPUS', '0'], ['', '1742912']] }).size).toBe(0);
  });

  test('EDGAR urls are validated, never guessed', () => {
    expect(nportUrlFor('0001742912', '0002000324-26-004454')).toBe('https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/primary_doc.xml');
    expect(() => nportUrlFor('1742912', 'not-an-accession')).toThrow('EDGAR');
    expect(() => nportUrlFor('cik', '0002000324-26-004454')).toThrow('EDGAR');
    expect(edgarSeriesFilingsUrl('S000070027')).toContain('CIK=S000070027');
    expect(edgarSeriesFilingsUrl('S000070027')).toContain('output=atom');
  });

  test('the trust submissions feed yields only NPORT-P accessions', () => {
    const filings = parseNportAccessions(JSON.parse(EDGAR_SUBMISSIONS));
    expect(filings.length).toBe(2);
    expect(filings[0].accession).toBe('0002000324-26-004454');
    expect(filings[0].reportDate).toBe('2026-07-31');
    expect(filings[0].url).toContain('edgar/data/1742912/000200032426004454/');
    expect(parseNportAccessions({ cik: '1', filings: { recent: { form: ['10-K'], accessionNumber: ['x'] } } })).toEqual([]);
  });

  test('the series Atom feed is parsed for accession, date and href CIK', () => {
    const atom = `<feed><entry><filing-type>NPORT-P</filing-type><filing-date>2026-09-21</filing-date>
      <period>2026-07-31</period><accession-number>0002000324-26-004454</accession-number>
      <filing-href>https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/0002000324-26-004454-index.htm</filing-href></entry>
      <entry><filing-type>N-PORT</filing-type><accession-number>0000000000-00-000000</accession-number></entry></feed>`;
    const filings = parseEdgarAtomFilings(atom);
    expect(filings.length).toBe(1);
    expect(filings[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/primary_doc.xml');
    expect(parseEdgarAtomFilings('<feed></feed>')).toEqual([]);
  });

  test('the N-PORT reader keeps identifiers, weights, USD values and balances', () => {
    const parsed = parseNport(NPORT_XML);
    expect(parsed.regCik).toBe('0001742912');
    expect(parsed.seriesName).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(parsed.seriesId).toBe('S000070027');
    expect(parsed.repPdDate).toBe('2026-07-31');
    expect(parsed.netAssets).toBe(3283824025);
    expect(parsed.holdings.length).toBe(5);
    expect(parsed.holdings[0]).toEqual({
      Name: 'NVIDIA CORP', Ticker: '—', Identifier: '67066G104', Weight: '14.14%',
      'Market Value': '$464404792.12', 'Shares Held': '2033474', 'Asset Category': 'EC',
    });
    expect(parsed.holdings[3].Weight).toBe('-0.12%');
    expect(parsed.totalValue).toBe((464404792.12 + 408383425.06 + 16400000 - 3940000 + 39400000));
  });

  test('a filing only matches its own series and only its own registrant', () => {
    const parsed = parseNport(NPORT_XML);
    const ref = parseFundTickerMap(seriesPayload).get('SPUS')!;
    expect(matchesNportFund(parsed, 'SPUS', null, ref, TIDAL_TRUST.cik)).toBe(true);
    expect(matchesNportFund(parsed, 'SPRE', null, parseFundTickerMap(seriesPayload).get('SPRE')!, TIDAL_TRUST.cik)).toBe(false);
    // Same series ID but another registrant: reject.
    expect(matchesNportFund(parsed, 'SPUS', null, { ...ref, cik: '0000000001' }, TIDAL_TRUST.cik)).toBe(false);
    // No ticker-table entry: the series name decides, and an unrelated name is rejected.
    expect(matchesNportFund(parsed, 'SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF', null, TIDAL_TRUST.cik)).toBe(true);
    expect(matchesNportFund(parsed, 'SPUS', 'SP Funds Dow Jones Global Sukuk ETF', null, TIDAL_TRUST.cik)).toBe(false);
    expect(matchesNportFund({ ...parsed, holdings: [] }, 'SPUS', null, ref, TIDAL_TRUST.cik)).toBe(false);
  });

  test('company ticker completion only fills plain equity rows', () => {
    const names = parseCompanyTickerMap({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
    expect(names.get(normalizeHoldingName('Apple Inc'))).toBe('AAPL');
    const rows: SheetRow[] = [
      { 'Name': 'Apple Inc', 'Ticker': '—', 'Identifier': '037833100', 'Weight': '1%', 'Market Value': '', 'Shares Held': '', 'Asset Category': 'EC' },
      { 'Name': 'US Treasury Bill', 'Ticker': '—', 'Identifier': '912797XX1', 'Weight': '1%', 'Market Value': '', 'Shares Held': '', 'Asset Category': 'DBT' },
    ];
    const filled = fillNportTickers(rows, names);
    expect(filled[0]['Ticker']).toBe('AAPL');
    expect(filled[1]['Ticker']).toBe('—');
  });

  test('the fallback walks the series feed, rejects other series and reports the filing URL', async () => {
    const calls: string[] = [];
    const atom = (accession: string) => `<feed><entry><filing-type>NPORT-P</filing-type><accession-number>${accession}</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1742912/${accession.replace(/-/g, '')}/x-index.htm</filing-href></entry></feed>`;
    const transport: Transport = async (url) => {
      calls.push(url);
      if (url.includes('browse-edgar')) {
        // SPUS's own series feed; SPRE's returns the SPUS filing to prove the series check.
        return new Response(url.includes('CIK=S000070027') ? atom('0002000324-26-004454') : atom('0002000324-26-004454'), { status: 200 });
      }
      if (url.includes('primary_doc.xml')) return new Response(NPORT_XML, { status: 200 });
      if (url.includes('company_tickers')) return new Response(JSON.stringify(seriesPayload), { status: 200 });
      return new Response(EDGAR_SUBMISSIONS, { status: 200 });
    };
    const fallback = createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, () => {});
    const result = await fallback('SPUS', null);
    expect(result).not.toBeNull();
    expect(result!.asOfDate).toBe('2026-07-31');
    expect(result!.rows.length).toBe(5);
    expect(result!.source).toContain('000200032426004454');
    expect(result!.rows[0]['Weight']).toBe('14.14%');
    // The cash row keeps its negative sign, and rows sort by weight descending.
    const cash = result!.rows.find((row) => row['Name'] === 'Cash & Other')!;
    expect(cash['Market Value']).toBe('$-3940000.00');
    expect(cash['Weight']).toBe('-0.12%');
    expect(Number(result!.rows[0]['Weight'].replace('%', ''))).toBeGreaterThan(Number(result!.rows[1]['Weight'].replace('%', '')));
    // The trust submissions feed is never consulted when the series feed answers.
    expect(calls.some((url) => url.includes('submissions'))).toBe(false);

    calls.length = 0;
    // Another series' filing is rejected: the published rows are never mixed.
    expect(await fallback('SPRE', null)).toBeNull();
    expect(calls.filter((url) => url.includes('primary_doc.xml')).length).toBe(1);
  });

  test('the fallback refuses a registrant outside the two verified trusts', async () => {
    const transport: Transport = async (url) => {
      if (url.includes('company_tickers')) {
        return new Response(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [['999999', 'S000000001', 'C000000001', 'SPUS']] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const fallback = createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, () => {});
    expect(await fallback('SPUS', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-fund updates
// ---------------------------------------------------------------------------

describe('per-fund update', () => {
  test('SPUS: metadata, metrics and paged holdings/history land in the sibling contract', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig({ HOLDINGS_PAGE_SIZE: '4', HISTORY_PAGE_SIZE: '10' }), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));
    expect(outcome.providers.spFunds).toBe(true);
    expect(outcome.providers.yahoo).toBe(true);
    expect(outcome.providers.retained).toEqual([]);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.written).toBe(true);

    const meta = JSON.parse(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8'));
    expect(meta['name']).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(meta['ter']).toBe('0.45%');
    expect(meta['nav']).toBe('$59.54');
    expect(meta['aum']).toBe('$3.27B');
    expect(meta['aumValue']).toBe(3274890000);
    expect(meta['asOfDate']).toBe('2026-09-30');
    expect(meta['inceptionDate']).toBe('2019-12-17');
    expect(meta['exchange']).toBe('NYSE');
    expect(meta['closePrice']).toBe('$59.54');
    expect(meta['premiumDiscount']).toBe('-0.01%');
    expect(meta['cusip']).toBe('886364801');
    expect(meta['sharesOutstanding']).toBe(55000000);
    expect(meta['midpoint']).toBe(27500000 * 2 * 59.54);
    expect(meta['identifiers']).toEqual({ cusip: '886364801', isin: null, indexTicker: 'SPSIEUT', benchmark: 'S&P 500 Shariah Industry Exclusions Index (USD) TR' });
    expect(meta['yields']['dividendYieldText']).toBe('0.52%');
    expect(meta['yields']['secYieldText']).toBe('0.40%');
    expect(meta['yields']['secYieldKind']).toContain('official SP Funds 30-day SEC yield');
    expect(meta['returns']['monthEnd']['yr1']).toBe(21.21);
    expect(meta['returns']['quarterEnd']['asOfDate']).toBe('2026-09-30');
    expect(meta['distributions']['frequency']).toBe('Monthly');
    expect(meta['distributions']['headers']).toEqual(['Ex-Date', 'Record Date', 'Payable Date', 'Amount']);
    expect(meta['distributions']['rows'][0]).toEqual(['2026-09-28', '2026-09-28', '2026-09-29', '0.026']);
    expect(meta['source']['trust']).toBe('Tidal Trust I');
    expect(meta['source']['trustCik']).toBe('0001742912');
    expect(meta['source']['holdingsSource']).toContain('TidalFG_Holdings_SPUS.csv');
    expect(meta['holdings']).toEqual({ pages: ['001.json', '002.json'], pageSize: 4, totalRows: 6, asOfDate: '2026-10-01' });
    expect(meta['history'].pages.length).toBe(3);
    expect(meta['history'].totalRows).toBe(30);
    expect(meta['documents']['prospectus']).toContain('spfunds-PRO_032626_web.pdf');

    const page = JSON.parse(await readFile(new URL('funds/SPUS/holdings/001.json', apiRoot), 'utf8'));
    expect(page['headers']).toEqual(HOLDINGS_HEADERS);
    expect(Array.isArray(page['rows'])).toBe(true);
    expect(Object.keys(page['rows'][0])).toEqual(HOLDINGS_HEADERS);
    expect(page['rows'][0]['Weight']).toBe('14.14%');
    const history = JSON.parse(await readFile(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    expect(history['headers']).toEqual(HISTORY_HEADERS);
    expect(Object.keys(history['rows'][0])).toEqual(HISTORY_HEADERS);
  });

  test('a fund whose issuer data is unavailable keeps its published pages and says so', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));

    const broken: Transport = async (url, label, init) => {
      if (url.includes('TidalFG_Holdings')) throw new Error('HTTP 500');
      if (url.endsWith('.com/spus/')) throw new Error('HTTP 503');
      return transport(url, label, init);
    };
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, broken, null, new Date('2026-10-02T12:00:00Z'));
    expect(outcome.providers.spFunds).toBe(false);
    expect(outcome.providers.yahoo).toBe(true);
    expect(outcome.providers.retained).toEqual(['issuer page', 'holdings']);
    expect(outcome.reason).toContain('retained');
    const meta = JSON.parse(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8'));
    // Previously published facts survive a transient issuer outage.
    expect(meta['nav']).toBe('$59.54');
    expect(meta['identifiers']['cusip']).toBe('886364801');
    expect(meta['holdings'].totalRows).toBe(6);
    expect(meta['source']['holdingsSource']).toContain('TidalFG_Holdings_SPUS.csv');
  });

  test('SKIP_SPFUNDS and SKIP_YAHOO keep the published feed untouched', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher, seen } = sampleFetcher();
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));
    const before = await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8');
    seen.length = 0;
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig({ SKIP_SPFUNDS: 'true', SKIP_YAHOO: 'true' }), apiRoot, transport, null, new Date('2026-10-03T12:00:00Z'));
    expect(seen.length).toBe(0);
    expect(outcome.written).toBe(false);
    expect(outcome.status).toBe('unchanged');
    expect(outcome.providers.retained).toEqual(['issuer page (SKIP_SPFUNDS)', 'holdings', 'history']);
    expect(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8')).toBe(before);
  });

  test('a young fund keeps its holdings and reports a cadence only when the dates show one', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    const outcome = await updateFund(fundFor('SPTE'), offlineConfig(), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));
    expect(outcome.entry['holdings']).toBe(4);
    const meta = JSON.parse(await readFile(new URL('funds/SPTE/meta.json', apiRoot), 'utf8'));
    expect(['Monthly', 'Quarterly', null]).toContain(meta['distributions']['frequency']);
  });
});

// ---------------------------------------------------------------------------
// Offline end-to-end run
// ---------------------------------------------------------------------------

describe('offline orchestration', () => {
  test('a full run publishes every fund, then repeats byte-for-byte', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher, seen } = sampleFetcher();
    const first = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(first.funds).toBe(5);
    expect(first.holdings).toBe(HOLDINGS_TOTAL);
    expect(first.history).toBe(HISTORY_TOTAL);
    expect(first.failures).toEqual([]);

    const index = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
    expect(index['counts']).toEqual({ funds: 5, holdings: HOLDINGS_TOTAL, history: HISTORY_TOTAL });
    expect(index['provider']).toBe('SP Funds');
    expect(index['source']['catalog']).toBe('https://www.sp-funds.com/');
    const spus = index['funds'].find((fund: JsonRecord) => fund['ticker'] === 'SPUS');
    expect(Object.keys(spus).sort()).toEqual([
      'aum', 'aumValue', 'asOfDate', 'category', 'closePrice', 'closePriceAsOfDate', 'cusip', 'dataFile',
      'distributions', 'exchange', 'fundPage', 'history', 'holdings', 'inceptionDate', 'isin', 'metrics', 'name',
      'nav', 'navValue', 'premiumDiscount', 'returns', 'ter', 'terValue', 'ticker',
    ].sort());
    expect(spus['distributions']).toEqual({ frequency: 'Monthly', exDate: '2026-09-28', dividend: '0.026' });
    expect(spus['metrics']['cagr3y']).toBe(25.32);
    expect(spus['metrics']['tr3y']).toBe(96.82);

    const tree = await listFiles(apiRoot);
    const before = new Map<string, string>();
    for (const file of tree) before.set(file, await readFile(new URL(file, apiRoot), 'utf8'));
    // index.json + meta + one holdings + one history page per fund; a full pass clears the cursor.
    expect(tree.length).toBe(1 + 5 * (1 + 1 + 1));
    expect(tree.every((file) => file === 'index.json' || file.startsWith('funds/'))).toBe(true);

    seen.length = 0;
    const second = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T18:30:00Z') });
    expect(second.written).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const file of tree) expect(await readFile(new URL(file, apiRoot), 'utf8'), file).toBe(before.get(file));
    expect(await listFiles(apiRoot)).toEqual(tree);
  });

  test('CONCURRENCY runs funds in parallel (worker pool), CONCURRENCY=1 is sequential', async () => {
    const parallel = sampleFetcher({}, 5);
    await runUpdater(offlineConfig({ CONCURRENCY: '3' }), { apiRoot: await tempApiRoot(), fetcher: parallel.fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(parallel.stats.maxInFlight).toBe(3);

    const wide = sampleFetcher({}, 5);
    await runUpdater(offlineConfig({ CONCURRENCY: '15' }), { apiRoot: await tempApiRoot(), fetcher: wide.fetcher, now: new Date('2026-10-01T12:00:00Z') });
    // one worker per fund at most: five funds, so five requests overlap
    expect(wide.stats.maxInFlight).toBe(5);

    const sequential = sampleFetcher({}, 5);
    await runUpdater(offlineConfig({ CONCURRENCY: '1' }), { apiRoot: await tempApiRoot(), fetcher: sequential.fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(sequential.stats.maxInFlight).toBe(1);
  });

  test('HISTORY_RANGE reaches the Yahoo request of every fund', async () => {
    const { fetcher, seen } = sampleFetcher();
    const now = new Date('2026-10-01T12:00:00Z');
    await runUpdater(offlineConfig({ HISTORY_RANGE: '5y', TICKERS: 'SPUS' }), { apiRoot: await tempApiRoot(), fetcher, now });
    const chart = seen.filter((url) => url.includes('finance.yahoo.com'));
    expect(chart.length).toBe(1);
    expect(Number(new URL(chart[0]).searchParams.get('period1'))).toBe(Math.floor(now.getTime() / 1000 - 5 * 365.25 * 86_400));
  });

  test('the ticker cursor rotates bounded runs, keeps published funds and resumes only in the same scope', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const one = await runUpdater(offlineConfig({ MAX_FETCHES: '1' }), { apiRoot, fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(one.funds).toBe(1);
    expect(await readCursor(apiRoot)).toBe('SPRE');
    // A different selection scope must not inherit the cursor.
    expect(await readCursor(apiRoot, 'another-scope')).toBeNull();
    await writeCursor(apiRoot, null);
    expect(await readCursor(apiRoot)).toBeNull();

    const two = await runUpdater(offlineConfig({ MAX_FETCHES: '2' }), { apiRoot, fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(two.funds).toBe(2);
    expect(await readCursor(apiRoot)).toBe('SPSK');
    const index = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
    // Bounded runs never shrink the published catalog below the discovered lineup.
    expect(index['counts']['funds']).toBe(5);
    expect(index['funds'].map((fund: JsonRecord) => fund['ticker'])).toEqual(TICKERS);
    // Funds processed earlier in the sweep still carry their rows.
    expect(index['funds'][0]['holdings']).toBe(SAMPLES['SPRE'].csv.length); // SPRE ran first in the sweep
    expect(index['funds'][2]['holdings']).toBe(0); // SPTE still has its placeholder row

    const full = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T13:00:00Z') });
    expect(full.funds).toBe(5);
    // A full pass clears the cursor again.
    expect(await readCursor(apiRoot)).toBeNull();
  });

  test('filters keep out funds whose facts fall outside the range', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T12:00:00Z') });
    const index = await readPreviousIndex(apiRoot);
    expect(index.size).toBe(5);
    // Only SPUS publishes more than $1B of net assets.
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { lines.push(String(value)); };
    let summary;
    try {
      summary = await runUpdater(offlineConfig({ AUM: '1B:' }), { apiRoot, fetcher, now: new Date('2026-10-02T12:00:00Z') });
    } finally {
      console.log = original;
    }
    // Range filters are data-dependent: every fund is processed, only SPUS writes.
    expect(summary!.funds).toBe(5);
    expect(summary!.skipped.sort()).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPWO']);
    expect(lines.some((line) => line === '[ filter   ] 5 of 5 funds pass filters')).toBe(true);
    // Four funds are skipped in parallel: only the reason and status are guaranteed.
    expect(lines.filter((line) => line.includes('  skipped') && line.includes('reason=filter: aum')).length).toBe(4);
    expect(lines.some((line) => line.startsWith('[ done     ] counts:') && line.includes(`holdings=${HOLDINGS_TOTAL}`))).toBe(true);
    const after = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
    // Skipped funds keep their published entry: the feed never shrinks silently.
    expect(after['funds'].map((fund: JsonRecord) => fund['ticker'])).toEqual(TICKERS);
  });

  test('a fund whose Yahoo request fails is reported and does not stop the run', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = sampleFetcher();
    const exploding = async (url: string): Promise<Response> => {
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart/SPUS')) throw new Error('yahoo is down');
      return fetcher(url);
    };
    const summary = await runUpdater(offlineConfig({ MAX_RETRIES: '1' }), { apiRoot, fetcher: exploding as unknown as typeof fetch, now: new Date('2026-10-01T12:00:00Z') });
    expect(summary.funds).toBe(5);
    expect(summary.failures).toEqual([]);
    const meta = JSON.parse(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8'));
    expect(meta['history'].totalRows).toBe(0); // first run, nothing published to retain
    expect(meta['holdings'].totalRows).toBe(6);
    expect(meta['source']['historySource']).toContain('yahoo');
  });

  test('the catalog index carries the provider, trust and per-fund provenance', () => {
    const funds = buildCatalog(HOME_HTML, []);
    const index = buildCatalogIndex('SP Funds', funds, HOLDINGS_TOTAL, HISTORY_TOTAL, '2026-10-01T00:00:00.000Z');
    expect(index['counts']).toEqual({ funds: 5, holdings: HOLDINGS_TOTAL, history: HISTORY_TOTAL });
    expect(index['source']['trust']).toBe('Tidal Trust I');
    expect(index['source']['trustCik']).toBe('0001742912');
    expect(index['source']['nportTrustCik']).toContain('0001989916');
    expect(catalogIndexEntry({ entry: { ticker: 'SPUS' } } as unknown as FundOutcome)).toEqual({ ticker: 'SPUS' });
  });
});

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
