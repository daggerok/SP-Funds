/// <reference types="bun" />
/**
 * Offline tests for the SP Funds feed updater. Every sample is a small inline
 * excerpt in the shape the real pages and feeds use; no test performs network I/O.
 * Groups (same names in every ETF repo): controls, parsing, metrics, pipeline, network.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOSED_FUNDS, CONTROL_NAMES, HISTORY_HEADERS, HOLDINGS_GUARD_RELAX, HOLDINGS_HEADERS, SEC_UA_DEFAULT, SPFUNDS_TRUST, TIDAL_TRUST, USAGE,
  annualizedFromCumulative, batchSelection, buildCatalog, buildCatalogIndex, yahooHeaders, buildPages,
  catalogIndexEntry, closedFund, createEdgarFallback, createRequestGate, createTransport, cumulativeFromAnnualized, deriveMetrics,
  performanceAsOf, errorMessage, formatAumDisplay, formatMoneyText,
  formatUsDate, fundFilterReasons, fundPageUrl, holdingsCsvUrl, holdingsGuard, holdingsWeightCount, inferDistributionFrequency, liveLineup, lookupPattern,
  matchesRange, mergeDividends, nameValueMap, normalizeWeightText, nportHoldingsSheet, nportIsFresh, nportTickers, parseMoneyNumber,
  numberOrNull, outputPrintConfig, pageFileName, parseAumRange, parseCatalogCards, parseCatalogMenu,
  parseCsv, parseFundPage, parseHtmlTables, parseNportFiling, parseSecCompanyNames, parseSecFundTickers,
  parseRange, parseSpFundsHoldingsCsv, parseYahooChart, paymentsPerYear, periodKey,
  readConfig, readCursor, readPreviousIndex, readPreviousPages, resolveControls, round, runUpdater, runtimeControls,
  samePublishedContent, sanitizeTicker, secHeaders, selectionEntryFromIndex, splitPages, spFundsAssetCategory,
  stableStringify, toIsoDate, trustForTicker, installSystemCa, isCertError, updateFund, writeIfChanged, writePages,
  writeCursor, yahooChartUrl, dayFromHistoryRow, emptyMetrics, formatSheetDate, historyRowsFromDays, isoStamp,
  mergeHistoryDays, ADJ_CLOSE_NOISE, entryFromMeta, placeholderEntry, type CatalogFund, type FundOutcome, type JsonRecord,
  type SheetRow, type Transport, type UpdaterConfig
} from './update-data';
import type { DerivedMetrics } from './update-data';

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
// the 52-week range keys every index row gets from its published history pages (shared range-52w block)
const RANGE_KEYS = ['week52Low', 'week52High', 'range52w', 'range52wClose', 'range52wAsOf', 'range52wSince', 'range52wBasis'];

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
// CSV rows: StockTicker, CUSIP, SecurityName, Shares, Price, MarketValue, Weightings (each sample adds up to 74..100%, like a real sheet)
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
      ['MU', '595112103', 'Micron Technology Inc', '94901', '1065.11', '101080004.11', '54.24%'],
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
      ['AA AU', 'B0000AA', 'Another Group', '1', '1.0', '1.0', '65.58%'],
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
      ['MSFT', '594918104', 'Microsoft Corp', '500', '512.9', '256450.0', '73.00%'],
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
      ['TM', '892331307', 'Toyota Motor', '10', '200.0', '2000.0', '85.00%'],
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
    </fundInfo>
    <invstOrSecs>
      <invstOrSec><name>NVIDIA CORP</name><lei>549300S4KLFTLO7GSQ80</lei><title>NVIDIA CORP</title><cusip>67066G104</cusip><identifiers><isin value="US67066G1040"/><ticker value="NVDA"/></identifiers><balance>2033474.00000000</balance><units>NS</units><curCd>USD</curCd><valUSD>1313535202.12</valUSD><pctVal>40.00000000</pctVal><assetCat>EC</assetCat><issuerCat>CORP</issuerCat><invCountry>US</invCountry></invstOrSec>
      <invstOrSec><name>APPLE INC</name><title>APPLE INC</title><cusip>037833100</cusip><identifiers><isin value="US0378331005"/></identifiers><balance>1226303</balance><units>NS</units><curCd>USD</curCd><valUSD>985147207.59</valUSD><pctVal>30.00000000</pctVal><assetCat>EC</assetCat><invCountry>US</invCountry></invstOrSec>
      <invstOrSec><name>TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD</name><title>TSMC</title><cusip>N/A</cusip><identifiers><isin value="TW0002330008"/><ticker value="2330"/></identifiers><balance>500</balance><units>NS</units><curCd>TWD</curCd><valUSD>656764805.06</valUSD><pctVal>20.00000000</pctVal><assetCat>EC</assetCat><invCountry>TW</invCountry></invstOrSec>
      <invstOrSec><name>SP Funds S&amp;P Global REIT Sharia ETF</name><cusip>886364108</cusip><identifiers><ticker value="SPRE"/></identifiers><balance>865000</balance><curCd>USD</curCd><valUSD>164191201.25</valUSD><pctVal>5.00000000</pctVal><assetCat>RF</assetCat></invstOrSec>
      <invstOrSec><name>Cash &amp; Other</name><cusip>000000000</cusip><identifiers><other otherDesc="Internal" value="CASH"/></identifiers><curCd>USD</curCd><valUSD>-3940000.00</valUSD><assetCat>STIV</assetCat></invstOrSec>
      <invstOrSec><name>US TREASURY BILL 0% 09/17/2026</name><cusip>912797XX1</cusip><identifiers><ticker value="T"/></identifiers><balance>39400000</balance><curCd>USD</curCd><valUSD>131352960.50</valUSD><pctVal>4.00000000</pctVal><assetCat>DBT</assetCat><debtSec><maturityDt>2026-09-17</maturityDt><annualizedRt>0</annualizedRt></debtSec></invstOrSec>
      <invstOrSec><name>S&amp;P 500 E-MINI DEC26</name><cusip>000000000</cusip><identifiers><other otherDesc="Bloomberg Identifier" value="BBG01VKPGXL9"/></identifiers><curCd>USD</curCd><valUSD>164191.20</valUSD><pctVal>0.00500000</pctVal><assetCat>DE</assetCat><derivativeInfo><futrDeriv derivCat="FUT"><descRefInstrmnt><otherRefInst><identifiers><cusip value="78462F103"/><ticker value="SPY"/></identifiers></otherRefInst></descRefInstrmnt></futrDeriv></derivativeInfo></invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;
/** SEC company_tickers.json excerpt: issuer names for the N-PORT ticker match (the T-bill is no "T" for AT&T). */
const COMPANY_NAMES = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' }, 1: { cik_str: 732717, ticker: 'T', title: 'AT&T INC.' } };
/** The browse-edgar Atom feed of the SPUS series with one NPORT-P filing in the Tidal Trust I folder. */
const NPORT_ATOM = `<feed><entry><content><accession-number>0002000324-26-004454</accession-number><filing-date>2026-09-21</filing-date>
  <filing-href>https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/0002000324-26-004454-index.htm</filing-href>
  <filing-type>NPORT-P</filing-type><period>2026-07-31</period></content></entry></feed>`;

/** Routes every outbound URL of an offline run to the inline samples. */
function sampleRoutes(overrides: Record<string, string> = {}): Array<[RegExp, (match: RegExpExecArray) => string]> {
  return [
    [/^https:\/\/www\.sp-funds\.com\/$/, () => overrides['home'] ?? HOME_HTML],
    [/^https:\/\/www\.sp-funds\.com\/([a-z]+)\/$/, (match) => overrides[match[1]] ?? fundPageHtml(match[1].toUpperCase())],
    [/TidalFG_Holdings_([A-Z]+)\.csv$/, (match) => overrides[`csv-${match[1]}`] ?? holdingsCsv(match[1])],
    [/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([A-Z]+)/, (match) => overrides[`yahoo-${match[1]}`] ?? yahooJson(match[1])],
    [/data\.sec\.gov\/submissions\/CIK0001742912/, () => overrides['tidal'] ?? EDGAR_SUBMISSIONS],
    [/company_tickers_mf\.json/, () => overrides['series'] ?? JSON.stringify(SERIES_PAYLOAD)],
    [/company_tickers\.json/, () => overrides['names'] ?? JSON.stringify(COMPANY_NAMES)],
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

/** The last `days` of a fund's Yahoo sample, as a HISTORY_RANGE window returns them; `adjust` re-scales Adj Close (a new distribution). */
const yahooWindow = (ticker: string, days: number, adjust = 1): string => {
  const payload = JSON.parse(yahooJson(ticker));
  const result = payload.chart.result[0];
  result.timestamp = result.timestamp.slice(-days);
  result.indicators.quote[0].close = result.indicators.quote[0].close.slice(-days);
  result.indicators.quote[0].volume = result.indicators.quote[0].volume.slice(-days);
  result.indicators.adjclose[0].adjclose = result.indicators.adjclose[0].adjclose.slice(-days).map((value: number) => value * adjust);
  return JSON.stringify(payload);
};

/** Every file of a feed with its text. */
async function snapshot(apiRoot: URL): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of await listFiles(apiRoot)) files[file] = await readFile(new URL(file, apiRoot), 'utf8');
  return files;
}

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
});

describe('controls 2', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));

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
    // TOTAL_RETURN_* reads the derived tr* keys of the metrics (it used the official yr* keys, which metrics do not have, and rejected every fund)
    const withMetrics = { ...entry, metrics: { ytd: 5, tr1y: 10, tr3y: null, tr5y: null, tr10y: null } as DerivedMetrics };
    expect(fundFilterReasons(withMetrics, readConfig({ TOTAL_RETURN_1Y: '0:20' }))).toEqual([]);
    expect(fundFilterReasons(withMetrics, readConfig({ TOTAL_RETURN_1Y: '0:5' }))).toEqual(['total_return_1y']);
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

  test('--help lists every control', () => {
    for (const name of CONTROL_NAMES) expect(USAGE, name).toContain(name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '_<P>'));
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
      for (const zone of ['Pacific/Kiritimati', 'Asia/Tokyo', 'America/Los_Angeles', 'UTC']) {
        process.env['TZ'] = zone;
        // month-name and U.S. dates are plain calendar text (shared calendarIso), the same day in every zone
        expect(['Oct 24, 2026', 'October 24 2026', '24 Oct 2026', '10/24/2026', '10/24/26', '2026-10-24', 'Sept. 24, 2026'].map((raw) => toIsoDate(raw)))
          .toEqual([...Array(6).fill('2026-10-24'), '2026-09-24']);
        expect(toIsoDate('02/30/2026')).toBeNull();
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
    const catalog = buildCatalog(HOME_HTML);
    expect(catalog.map((fund) => fund.ticker)).toEqual(TICKERS);
    expect(catalog.find((fund) => fund.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(parseCatalogCards(HOME_HTML).find((card) => card.ticker === 'SPUS')!.fundPage).toBe('https://www.sp-funds.com/spus/');
    const synthetic = `<li><a href="#"><span>Our ETFs</span></a><ul class="sub-menu"><li><a href="/spre/"><span>SPRE</span></a></li></ul></li>
      <div class="bdt-ep-advanced-icon-box-content"><h3 class="bdt-ep-advanced-icon-box-title"><span>SPRE</span></h3>
      <a class="bdt-ep-advanced-icon-box-readmore" href="/spre-2/">See Details</a></div>`;
    expect(parseCatalogCards(synthetic)[0].fundPage).toBe('https://www.sp-funds.com/spre-2/');
    expect(buildCatalog(synthetic)[0].fundPage).toBe('https://www.sp-funds.com/spre/');
    const withOther = HOME_HTML.replace('</ul></li>', '</ul></li><li><a href="#"><span>Target Date Funds</span></a><ul class="sub-menu"><li><a href="/sptax/"><span>SPTAX</span></a></li></ul></li>');
    expect(parseCatalogMenu(withOther).length).toBe(5);
    expect(parseCatalogMenu(withOther).map((card) => card.ticker)).not.toContain('SPTAX');
  });

  test('the catalog is the whole live lineup (TICKERS never adds a fund); unknown markup falls back to the known lineup and is no live lineup', () => {
    expect(liveLineup(HOME_HTML)).toEqual(['SPRE', 'SPUS', 'SPTE', 'SPSK', 'SPWO']);
    expect(liveLineup('<html>redesigned</html>')).toBeNull();
    expect(buildCatalog('<html>redesigned</html>').map((fund) => fund.ticker)).toEqual(TICKERS);
    expect(buildCatalog('<p>no cards</p>').map((fund) => fund.fundPage)).toContain('https://www.sp-funds.com/spus/');
  });
});

describe('parsing 2', () => {
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
});

describe('parsing 3', () => {
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

  test('SEC EDGAR fallback (shared nport-reader): ticker map, N-PORT sheet with empty missing numbers, own identifiers, tickers only for U.S. equities', () => {
    const map = parseSecFundTickers(SERIES_PAYLOAD);
    expect(map.get('SPUS')).toEqual({ cik: '0001742912', seriesId: 'S000070027', classId: 'C000220954' });
    expect(map.get('SPTE')!.cik).toBe('0001989916');
    expect(map.has('SPWO')).toBe(false);
    expect(parseSecFundTickers({ fields: ['symbol', 'cik', 'seriesId'], data: [['SPUS', '0', 'S000070027'], ['', '1742912', 'S000070027']] }).size).toBe(0);
    const filing = parseNportFiling(NPORT_XML);
    expect([filing.seriesId, filing.repPdDate, filing.netAssets, filing.regCik, filing.positions.length]).toEqual(['S000070027', '2026-07-31', 3283824025, '0001742912', 7]);
    const rows = nportHoldingsSheet(filing, nportTickers(filing.positions, parseSecCompanyNames(COMPANY_NAMES)));
    expect(Object.keys(rows[0])).toEqual(HOLDINGS_HEADERS);
    expect(rows[0]).toEqual({ Name: 'NVIDIA CORP', Ticker: 'NVDA', Identifier: '67066G104', Weight: '40', 'Market Value': '1313535202.12', 'Shares Held': '2033474', 'Asset Category': 'EC' });
    // heaviest first; Apple by its SEC issuer name; TSMC (TWD, TW ISIN) keeps its ISIN and no "2330"; the fund and the T-bill keep no
    // ticker (no "T" for AT&T); cash has an empty weight and balance, never 0; the future keeps its own id, not SPY's
    expect(rows.slice(1).map((row) => [row.Name, row.Ticker, row.Identifier, row.Weight, row['Shares Held']])).toEqual([
      ['APPLE INC', 'AAPL', '037833100', '30', '1226303'],
      ['TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD', '—', 'TW0002330008', '20', '500'],
      ['SP Funds S&P Global REIT Sharia ETF', '—', '886364108', '5', '865000'],
      ['US TREASURY BILL 0% 09/17/2026', '—', '912797XX1', '4', '39400000'],
      ['S&P 500 E-MINI DEC26', '—', 'BBG01VKPGXL9', '0.005', ''],
      ['Cash & Other', '—', 'CASH', '', ''],
    ]);
    expect(rows[6]['Market Value']).toBe('-3940000');
  });

  test('N-PORT freshness: a report replaces published holdings only when strictly newer; nothing published accepts any report', () => {
    expect(nportIsFresh('2026-07-31', '2026-10-23', 218)).toBe(false); // the daily issuer CSV sheet is newer than the quarterly report
    expect(nportIsFresh('2026-07-31', '2026-07-31', 218)).toBe(false);
    expect(nportIsFresh('2026-07-31', '2026-04-30', 218)).toBe(true);
    expect(nportIsFresh('', '2026-04-30', 218)).toBe(false);
    expect(nportIsFresh('2026-07-31', null, 0)).toBe(true);
    expect(nportIsFresh('2026-07-31', null, 218)).toBe(false); // published rows without a date cannot be compared: keep them
  });

  test('holdings guard: header-only, renamed weight column, broken weights, a bad weight sum and a halved sheet are rejected', () => {
    const headers = ['Name', 'Ticker', 'Weight'];
    const rows = [{ Name: 'A', Ticker: 'A', Weight: '60%' }, { Name: 'B', Ticker: 'B', Weight: '40%' }];
    expect(holdingsGuard(headers, rows, 2)).toBeNull();
    expect(holdingsGuard(headers, [['A', 'A', '60'], ['B', 'B', '40']], null)).toBeNull();
    expect(holdingsGuard([], [], 0)).toBeNull(); // nothing published before: an empty sheet is honest
    expect(holdingsGuard(headers, [], 505)).toContain('no holdings rows');
    expect(holdingsGuard(['Name', 'Ticker', 'Wt'], rows, 2)).toContain('no weight column');
    expect(holdingsGuard(headers, rows.map((row) => ({ ...row, Weight: '6\u200B0' })), 2)).toContain('numeric weight');
    const allocation = [{ Name: 'Cash&Collateral', Ticker: '-', Weight: '100' }, { Name: 'Equities', Ticker: '-', Weight: '476' }];
    expect(holdingsGuard(headers, allocation, 2)).toContain('outside 50..150');
    expect(holdingsGuard(headers, allocation, 2, ['sum'])).toBeNull();
    expect(holdingsGuard(headers, rows, 5)).toContain('less than half');
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
});

describe('metrics 2', () => {
  const official = { asOfDate: '2026-09-30', ytd: 17.13, yr1: 21.21, yr3: 25.32, yr5: 16.37, yr10: null, sinceInception: 18.57 };

  test('a fund younger than one year publishes no 1y, 3y or since-inception return, also when the page lost its fact table', async () => {
    const young = fundPageHtml('SPWO').replace('<td>11/30/2023</td>', '<td>01/15/2026</td>');
    const apiRoot = await tempApiRoot();
    const pick = (meta: JsonRecord): unknown[] => ['ytd', 'tr1y', 'tr3y', 'cagr3y', 'siAnn', 'performanceAsOf'].map((key) => (meta['metrics'] as JsonRecord)[key]);
    await updateFund(fundFor('SPWO'), offlineConfig(), apiRoot, quietTransport(sampleFetcher({ spwo: young }).fetcher), null, NOW);
    const meta = await readMeta(apiRoot, 'SPWO');
    expect(pick(meta)).toEqual([3.3, null, null, null, null, '2026-09-30']);
    expect((meta['returns'] as JsonRecord)['monthEnd']).toMatchObject({ ytd: 3.3, yr1: null, yr3: null, sinceInception: null });
    // no fact table on the next page: the inception is the published one and still decides (calendar anniversary, inclusive)
    const noFacts = stripTables(stripTables(young, 'Fund Inception'), 'Net Assets');
    await updateFund(fundFor('SPWO'), offlineConfig(), apiRoot, quietTransport(sampleFetcher({ spwo: noFacts }).fetcher), null, day(1));
    expect(pick(await readMeta(apiRoot, 'SPWO'))).toEqual([3.3, null, null, null, null, '2026-09-30']);
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
    // the index adds the 52-week range keys from the published history pages (shared range-52w block)
    const indexed = [...expected, ...RANGE_KEYS].sort();
    for (const row of rows) expect(Object.keys(row['metrics'] as JsonRecord).sort(), String(row['ticker'])).toEqual(indexed);
    const placeholder = placeholderEntry('SPWO', 'https://www.sp-funds.com/spwo/');
    const metrics = placeholder['metrics'] as JsonRecord;
    expect(Object.keys(metrics).sort()).toEqual(expected);
    for (const key of expected.filter((name) => name !== 'returnsBasis' && !name.endsWith('Text'))) expect(metrics[key], key).toBeNull();
    expect(String(metrics['returnsBasis']).length).toBeGreaterThan(0);
  });

  test('dividendYieldBasis: indicated with a yield, null with none, same key set on fresh, rebuilt and placeholder rows', () => {
    const fresh = deriveMetrics(official, 'Monthly', 0.026, 59.54, 0.4);
    expect(fresh.dividendYield).toBe(0.52);
    expect(fresh.dividendYieldBasis).toBe('indicated');
    const none = deriveMetrics(official, null, 0.026, 59.54, null);
    expect(none.dividendYield).toBeNull();
    expect(none.dividendYieldBasis).toBeNull();
    // a meta published before the key existed gets the code derived from its own yield, never a stale one
    const { dividendYieldBasis: _drop, ...legacy } = fresh;
    const rebuilt = entryFromMeta('SPUS', { metrics: legacy })['metrics'] as JsonRecord;
    expect(rebuilt['dividendYieldBasis']).toBe('indicated');
    const rebuiltNull = entryFromMeta('SPUS', { metrics: { ...legacy, dividendYield: null, dividendYieldText: '—' } })['metrics'] as JsonRecord;
    expect(rebuiltNull['dividendYieldBasis']).toBeNull();
    const placeholder = placeholderEntry('SPWO', null)['metrics'] as JsonRecord;
    expect(placeholder['dividendYieldBasis']).toBeNull();
    const keys = Object.keys(fresh).sort();
    expect(Object.keys(rebuilt).sort()).toEqual(keys);
    expect(Object.keys(placeholder).sort()).toEqual(keys);
    expect(Object.keys(none).sort()).toEqual(keys);
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
    expect(meta['holdings']).toEqual({ pages: ['holdings/001.json', 'holdings/002.json'], pageSize: 4, totalRows: 6, asOfDate: '2026-10-01' });
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
    for (const row of index['funds'] as JsonRecord[]) expect(Object.keys(row['metrics'] as JsonRecord)).toEqual(expect.arrayContaining(RANGE_KEYS));

    const tree = await listFiles(apiRoot);
    expect(tree.length).toBe(1 + 5 * 3); // index.json + meta, one holdings and one history page per fund
    const before = new Map<string, string>();
    for (const file of tree) before.set(file, await readFile(new URL(file, apiRoot), 'utf8'));
    seen.length = 0;
    const second = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: day(0.5) });
    expect(seen.length).toBeGreaterThan(0);
    expect(second.written).toBe(0);
    expect(await listFiles(apiRoot)).toEqual(tree);
    for (const file of tree) expect<string | undefined>(await readFile(new URL(file, apiRoot), 'utf8'), file).toBe(before.get(file));
  });

  test('two runs on the same source data write zero changes even when Yahoo adjusted closes jitter across a cent boundary', async () => {
    // Yahoo float32 noise seen live: SPDV 2024-11-12 came back as 31.544998 and 31.545001 a minute apart
    const jittered = (adjclose: number[]) => {
      const payload = JSON.parse(yahooJson('SPUS'));
      payload.chart.result[0].indicators.adjclose[0].adjclose.splice(5, adjclose.length, ...adjclose);
      return sampleFetcher({ 'yahoo-SPUS': JSON.stringify(payload) }).fetcher;
    };
    const apiRoot = await tempApiRoot();
    const config = offlineConfig({ TICKERS: 'SPUS' });
    await runUpdater(config, { apiRoot, fetcher: jittered([23.915001, 24.984999, 25.995001]), now: NOW });
    const tree = await listFiles(apiRoot);
    const read = async () => Promise.all(tree.map((file) => readFile(new URL(file, apiRoot), 'utf8')));
    const first = await read();
    const second = await runUpdater(config, { apiRoot, fetcher: jittered([23.914998, 24.985002, 25.994999]), now: day(0.5) });
    expect(second.written).toBe(0);
    expect(await listFiles(apiRoot)).toEqual(tree);
    expect(await read()).toEqual(first);
    // a real change beyond the noise is still written
    await runUpdater(config, { apiRoot, fetcher: jittered([23.9, 24.97, 25.98]), now: day(1) });
    expect(await read()).not.toEqual(first);
    const fresh = (adjCloseRaw: number) => ({ date: '2024-11-12', close: 33.93, adjClose: round(adjCloseRaw, 2), volume: 3900, adjCloseRaw });
    const published = [{ date: '2024-11-12', close: 33.93, adjClose: 31.54, volume: 3900 }];
    expect([31.545001, 31.5452, 31.56].map((raw) => mergeHistoryDays([fresh(raw)], published)[0].adjClose)).toEqual([31.54, 31.55, 31.56]);
    expect(ADJ_CLOSE_NOISE).toBe(1e-4);
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
    const catalog = buildCatalog(HOME_HTML);
    expect(batchSelection(catalog, 2, 'SPTE').map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    expect(batchSelection(catalog, 3, null).map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE']);
    batchSelection(catalog, 2, 'SPTE').splice(0);
    expect(catalog.length).toBe(5); // the batch never mutates the catalog
  });
});

describe('pipeline 2', () => {
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

  test('holdings that fail the guard fail the fund: a published fund stays exactly as published, a new fund gets a catalog-only row', async () => {
    const apiRoot = await tempApiRoot();
    const config = offlineConfig({ TICKERS: 'SPUS' });
    await runUpdater(config, { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const tree = await listFiles(apiRoot);
    const read = async () => Promise.all(tree.map((file) => readFile(new URL(file, apiRoot), 'utf8')));
    const first = await read();
    // the issuer renamed its weight column: every position parses without a weight
    const renamed = (ticker: string): string => holdingsCsv(ticker).replace('Weightings', 'Weighting (%)');
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    let second;
    try {
      second = await runUpdater(config, { apiRoot, fetcher: sampleFetcher({ 'csv-SPUS': renamed('SPUS') }).fetcher, now: day(1) });
    } finally {
      log.mockRestore();
    }
    expect(second.failures).toEqual(['SPUS']); // a failure, so main exits 1 like for any other failed fund
    expect(second.degraded).toEqual([]);
    expect(lines.filter((line) => /\] SPUS +failed .*holdings guard/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^\[ done +\] 1 fund: .*\b1 failed\b/.test(line))).toHaveLength(1);
    expect(second.written).toBe(0);
    expect(await listFiles(apiRoot)).toEqual(tree);
    expect(await read()).toEqual(first);

    const fresh = await tempApiRoot();
    const newFund = await runUpdater(offlineConfig({ TICKERS: 'SPRE SPWO' }), { apiRoot: fresh, fetcher: sampleFetcher({ 'csv-SPWO': renamed('SPWO') }).fetcher, now: NOW });
    expect(newFund.failures).toEqual(['SPWO']);
    expect((await listFiles(fresh)).filter((file) => file.startsWith('funds/SPWO/'))).toEqual([]);
    const row = ((await readIndex(fresh))['funds'] as JsonRecord[]).find((fund) => fund['ticker'] === 'SPWO')!;
    expect(row).toMatchObject({ dataFile: null, holdings: 0 });
    expect(Object.keys(row['metrics'] as JsonRecord).sort()).toEqual([...Object.keys(emptyMetrics()), ...RANGE_KEYS].sort());
    expect(String((row['metrics'] as JsonRecord)['returnsBasis'])).not.toBe('');
  });

  test('a closed fund is never fetched or reported failed: its files stay as published, its index row says closed, a rerun writes nothing', async () => {
    const entry = { ticker: 'SPSK', closed: '2026-10-01', source: 'https://www.sec.gov/Archives/edgar/data/1/notice.htm' };
    expect(() => closedFund([{ ...entry, closed: 'soon' }], 'SPSK')).toThrow('CLOSED_FUNDS');
    expect(closedFund([entry], 'spsk')).toEqual(entry);
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig(), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const snapshot = async (): Promise<Record<string, string>> => {
      const files: Record<string, string> = {};
      for (const file of await listFiles(apiRoot)) files[file] = await readFile(new URL(file, apiRoot), 'utf8');
      return files;
    };
    const first = await snapshot();
    const firstRow = ((await readIndex(apiRoot))['funds'] as JsonRecord[]).find((fund) => fund['ticker'] === 'SPSK')!;
    const renamed = holdingsCsv('SPSK').replace('Weightings', 'Weighting (%)'); // the guard would reject these holdings
    // the live lineup no longer lists SPSK
    const home = HOME_HTML.replace(/<li><a href="[^"]*\/spsk\/">[^\n]*<\/li>/, '');
    expect(buildCatalog(home).map((fund) => fund.ticker)).toEqual(['SPRE', 'SPTE', 'SPUS', 'SPWO']);
    CLOSED_FUNDS.push(entry);
    try {
      const one = sampleFetcher({ 'csv-SPSK': renamed, home });
      const summary = await runUpdater(offlineConfig({ TICKERS: 'SPSK' }), { apiRoot, fetcher: one.fetcher, now: day(1) });
      expect(one.seen.filter((url) => /spsk/i.test(url))).toEqual([]);
      expect([summary.funds, summary.failures, summary.degraded]).toEqual([0, [], []]);
      const closed = await snapshot();
      expect(Object.keys(closed)).toEqual(Object.keys(first));
      for (const path of Object.keys(first)) if (path !== 'index.json') expect([path, closed[path]]).toEqual([path, first[path]]);
      const rows = (await readIndex(apiRoot))['funds'] as JsonRecord[];
      expect(rows.map((row) => row['ticker'])).toEqual(TICKERS);
      expect(rows.find((row) => row['ticker'] === 'SPSK')).toMatchObject({ status: 'closed', closedDate: '2026-10-01', closedSource: entry.source, dataFile: firstRow['dataFile'] });
      expect(rows.filter((row) => row['status'] === 'closed')).toHaveLength(1);
      const all = sampleFetcher({ 'csv-SPSK': renamed, home });
      const rerun = await runUpdater(offlineConfig({ TICKERS: '' }), { apiRoot, fetcher: all.fetcher, now: day(1.5) });
      expect(all.seen.filter((url) => /spsk/i.test(url))).toEqual([]);
      expect([rerun.funds, rerun.failures, rerun.written]).toEqual([4, [], 0]);
      expect(await snapshot()).toEqual(closed);
    } finally {
      CLOSED_FUNDS.splice(CLOSED_FUNDS.indexOf(entry), 1);
    }
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
});

describe('pipeline 3', () => {
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

  test('EDGAR fallback: the fund own series filing rebuilds a fund with nothing published; a not newer report or another series never replaces holdings', async () => {
    const notes: string[] = [];
    const noCsv = failing(sampleFetcher({ atom: NPORT_ATOM, nport: NPORT_XML }).fetcher, 'TidalFG');
    const edgar = () => createEdgarFallback(offlineConfig(), quietTransport(noCsv), (line) => { notes.push(line); });
    // SPUS published from the 2026-10-01 issuer CSV: the 2026-07-31 report is not newer, the fund stays exactly as published
    const apiRoot = await publishedSpus();
    const before = await snapshot(apiRoot);
    const stale = await updateFund(fundFor('SPUS'), offlineConfig(), apiRoot, quietTransport(noCsv), edgar(), day(1));
    expect([stale.providers.edgar, stale.failedSources]).toEqual([false, ['holdings']]);
    expect(await snapshot(apiRoot)).toEqual(before);
    expect(notes).toContain('[ nport    ] SPUS: N-PORT 2026-07-31 is not newer than the published holdings (2026-10-01)');
    // nothing published: the report of the fund own series rebuilds the holdings
    const fresh = await tempApiRoot();
    const rebuilt = await updateFund(fundFor('SPUS'), offlineConfig(), fresh, quietTransport(noCsv), edgar(), day(1));
    expect(rebuilt.providers.edgar).toBe(true);
    const meta = await readMeta(fresh, 'SPUS');
    expect(meta['holdings']).toMatchObject({ totalRows: 7, asOfDate: '2026-07-31' });
    expect((meta['source'] as JsonRecord)['holdingsSource']).toBe('Tidal Trust I Form N-PORT-P (EDGAR accession 0002000324-26-004454, report period 2026-07-31)');
    const page = JSON.parse(await readFile(new URL('funds/SPUS/holdings/001.json', fresh), 'utf8'));
    expect(page['rows'].map((row: SheetRow) => row['Ticker'])).toEqual(['NVDA', 'AAPL', '—', '—', '—', '—', '—']);
    // SPRE gets no rows from the SPUS series filing
    notes.length = 0;
    const other = await updateFund(fundFor('SPRE'), offlineConfig(), await tempApiRoot(), quietTransport(noCsv), edgar(), day(1));
    expect(other.providers.edgar).toBe(false);
    expect(notes).toContain('[ nport    ] SPRE: no N-PORT-P filing of its own: 0002000324-26-004454 names series S000070027, not S000070034');
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
});

describe('pipeline 4', () => {
  test('a HISTORY_RANGE run after a full run keeps the older history and writes nothing; a re-adjusted window rescales it, one that does not join keeps the fund (Q25)', async () => {
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const first = await snapshot(apiRoot);
    const windowed = offlineConfig({ TICKERS: 'SPUS', HISTORY_RANGE: '1y' });
    const second = await runUpdater(windowed, { apiRoot, fetcher: sampleFetcher({ 'yahoo-SPUS': yahooWindow('SPUS', 5) }).fetcher, now: day(0.5) });
    expect(second.written).toBe(0);
    expect(await snapshot(apiRoot)).toEqual(first);
    // a distribution re-adjusted the whole Yahoo series by 0.98: the older published days are rescaled by the overlap, never left behind
    await runUpdater(windowed, { apiRoot, fetcher: sampleFetcher({ 'yahoo-SPUS': yahooWindow('SPUS', 10, 0.98) }).fetcher, now: day(1) });
    const history = JSON.parse(await readFile(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    expect(history['totalRows']).toBe(30);
    expect([history['rows'][0]['Adj Close'], history['rows'][29]['Adj Close']]).toEqual(['56.96', '57.25']);
    // a window that does not overlap the published days cannot be joined: the fund stays as published
    const gap = JSON.parse(yahooWindow('SPUS', 10));
    gap.chart.result[0].timestamp = gap.chart.result[0].timestamp.map((epoch: number) => epoch + 100 * 86_400);
    const before = await snapshot(apiRoot);
    const kept = await runUpdater(windowed, { apiRoot, fetcher: sampleFetcher({ 'yahoo-SPUS': JSON.stringify(gap) }).fetcher, now: day(2) });
    expect(kept.degraded).toEqual(['SPUS']);
    expect(await snapshot(apiRoot)).toEqual(before);
  });

  test('a relaxed guard still keeps numeric published weights from an all-blank weight sheet (Q24)', async () => {
    const apiRoot = await tempApiRoot();
    const config = offlineConfig({ TICKERS: 'SPUS' });
    await runUpdater(config, { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const first = await snapshot(apiRoot);
    const blank = holdingsCsv('SPUS', SAMPLES['SPUS'].csv.map((row) => [...row.slice(0, 6), '-']));
    HOLDINGS_GUARD_RELAX['SPUS'] = ['numeric', 'sum'];
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const second = await runUpdater(config, { apiRoot, fetcher: sampleFetcher({ 'csv-SPUS': blank }).fetcher, now: day(1) });
      expect(second.failures).toEqual(['SPUS']);
    } finally {
      delete HOLDINGS_GUARD_RELAX['SPUS'];
      log.mockRestore();
    }
    expect(await snapshot(apiRoot)).toEqual(first);
    expect(holdingsWeightCount(HOLDINGS_HEADERS, [{ Weight: '-' }, { Weight: '2' }])).toBe(1);
  });

  test('TICKERS outside the live lineup and the published feed stops the run before any fund request; a stale catalog-only row is dropped (Q27)', async () => {
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const index = await readIndex(apiRoot);
    index['funds'] = [...(index['funds'] as JsonRecord[]), placeholderEntry('NOPE', null)]; // an earlier mistyped TICKERS entry
    await writeFile(new URL('index.json', apiRoot), JSON.stringify(index));
    const before = await snapshot(apiRoot);
    const { fetcher, seen } = sampleFetcher();
    await expect(runUpdater(offlineConfig({ TICKERS: 'NOPE' }), { apiRoot, fetcher, now: day(1) }))
      .rejects.toThrow('TICKERS: NOPE not in the SP Funds lineup or published feed; nothing was fetched or written');
    expect(seen).toEqual([`${SPFUNDS}/`]);
    expect(await snapshot(apiRoot)).toEqual(before);
    await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher, now: day(1) });
    expect(tickersOf(await readIndex(apiRoot))).toEqual(TICKERS);
  });

  test('NEW FUNDS announces a fund on its first successful publish, a failed new fund as not published yet (Q28)', async () => {
    const apiRoot = await tempApiRoot();
    await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
    const index = await readIndex(apiRoot);
    index['funds'] = (index['funds'] as JsonRecord[]).filter((fund) => fund['ticker'] !== 'SPSK'); // SPSK is new in the lineup
    await writeFile(new URL('index.json', apiRoot), JSON.stringify(index));
    const down = (fetcher: typeof fetch): typeof fetch => ((url: string, init?: RequestInit) => (/spsk/i.test(url) ? Promise.resolve(new Response('no', { status: 404 })) : fetcher(url, init))) as typeof fetch;
    const summaryFile = new URL('../summary.md', apiRoot).pathname;
    process.env['GITHUB_STEP_SUMMARY'] = summaryFile;
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: unknown) => { if (/^NEW FUNDS/.test(String(line))) lines.push(String(line)); });
    try {
      const run = await runUpdater(offlineConfig(), { apiRoot, fetcher: down(sampleFetcher().fetcher), now: day(1) });
      expect([run.failures, run.newFunds]).toEqual([['SPSK'], ['SPRE', 'SPTE', 'SPWO']]);
      expect(lines).toEqual(['NEW FUNDS: SPRE, SPTE, SPWO', 'NEW FUNDS (not published yet): SPSK']);
      expect(readFileSync(summaryFile, 'utf8')).toContain('### NEW FUNDS\n\nNEW FUNDS: SPRE, SPTE, SPWO\nNEW FUNDS (not published yet): SPSK\n');
      lines.length = 0;
      await runUpdater(offlineConfig(), { apiRoot, fetcher: down(sampleFetcher().fetcher), now: day(2) });
      expect(lines).toEqual([]);
      await runUpdater(offlineConfig(), { apiRoot, fetcher: sampleFetcher().fetcher, now: day(3) });
      expect(lines).toEqual(['NEW FUNDS: SPSK']);
    } finally {
      log.mockRestore();
    }
  });
});

describe('pipeline 5', () => {
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
    const index = buildCatalogIndex('SP Funds', buildCatalog(HOME_HTML), HOLDINGS_TOTAL, HISTORY_TOTAL, '2026-10-01T00:00:00.000Z');
    expect(index['counts']).toEqual({ funds: 5, holdings: HOLDINGS_TOTAL, history: HISTORY_TOTAL });
    expect((index['source'] as JsonRecord)['trustCik']).toBe('0001742912');
    expect((index['source'] as JsonRecord)['nportTrustCik']).toContain('0001989916');
    expect(catalogIndexEntry({ entry: { ticker: 'SPUS' } } as unknown as FundOutcome)).toEqual({ ticker: 'SPUS' });
  });
});

describe('pipeline 6', () => {
  test('a new fund that no source answered is failed with a catalog-only row and no files; that row is never read back as published data', async () => {
    // SPWO is new and its page is a block page answered with HTTP 200; it has no holdings CSV, N-PORT-P filing or Yahoo chart
    const silent = (fetcher: typeof fetch): typeof fetch => ((url: string, init?: RequestInit) => {
      if (url.endsWith('.com/spwo/')) return Promise.resolve(new Response('<html><body>Access denied</body></html>'));
      return /spwo/i.test(url) ? Promise.resolve(new Response('no', { status: 404 })) : fetcher(url, init);
    }) as typeof fetch;
    const rowOf = async (root: URL, ticker: string): Promise<JsonRecord> => ((await readIndex(root))['funds'] as JsonRecord[]).find((fund) => fund['ticker'] === ticker)!;
    const fresh = await tempApiRoot();
    const apiRoot = await tempApiRoot();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runUpdater(offlineConfig({ TICKERS: 'SPWO' }), { apiRoot: fresh, fetcher: sampleFetcher().fetcher, now: NOW });
      await runUpdater(offlineConfig({ TICKERS: 'SPUS' }), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
      const silentRuns: Array<Record<string, string>> = [{ TICKERS: 'SPWO' }, { TICKERS: 'SPWO', SKIP_SPFUNDS: 'true', SKIP_YAHOO: 'true' }];
      for (const overrides of silentRuns) {
        const summary = await runUpdater(offlineConfig(overrides), { apiRoot, fetcher: silent(sampleFetcher().fetcher), now: day(1) });
        expect(summary.failures).toEqual(overrides.TICKERS.split(' ')); // never reported updated with an empty meta.json
        expect((await listFiles(apiRoot)).filter((file) => /^funds\/SPWO\//.test(file))).toEqual([]);
        for (const ticker of overrides.TICKERS.split(' ')) {
          const row = await rowOf(apiRoot, ticker);
          expect(row).toMatchObject({ dataFile: null, holdings: 0, history: 0 });
          expect(Object.keys(row['metrics'] as JsonRecord)).toEqual(Object.keys((await rowOf(apiRoot, 'SPUS'))['metrics'] as JsonRecord));
        }
      }
      // the first good refresh publishes exactly what a fund that never had a catalog-only row gets
      await runUpdater(offlineConfig({ TICKERS: 'SPWO' }), { apiRoot, fetcher: sampleFetcher().fetcher, now: NOW });
      expect(await rowOf(apiRoot, 'SPWO')).toEqual(await rowOf(fresh, 'SPWO'));
      expect(await readMeta(apiRoot, 'SPWO')).toEqual(await readMeta(fresh, 'SPWO'));
      expect((await rowOf(fresh, 'SPWO'))['dataFile']).not.toBeNull();
    } finally {
      log.mockRestore();
    }
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
});

describe('network 2', () => {
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

  test('the EDGAR fallback reads the series feed through the shared reader, refuses another series and reports the filing URL', async () => {
    const calls: string[] = [];
    const notes: string[] = [];
    const transport: Transport = async (url) => {
      calls.push(url);
      if (url.includes('browse-edgar')) return new Response(NPORT_ATOM, { status: 200 });
      if (url.includes('primary_doc.xml')) return new Response(NPORT_XML, { status: 200 });
      if (url.includes('company_tickers_mf')) return new Response(JSON.stringify(SERIES_PAYLOAD), { status: 200 });
      if (url.includes('company_tickers')) return new Response(JSON.stringify(COMPANY_NAMES), { status: 200 });
      return new Response(EDGAR_SUBMISSIONS, { status: 200 });
    };
    const fallback = createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, (line) => { notes.push(line); });
    const result = await fallback('SPUS', null, { asOf: null, rows: 0 });
    expect([result!.asOfDate, result!.rows.length, result!.accession]).toEqual(['2026-07-31', 7, '0002000324-26-004454']);
    expect(result!.source).toBe('https://www.sec.gov/Archives/edgar/data/1742912/000200032426004454/primary_doc.xml');
    expect(Number(result!.rows[0]['Weight'])).toBeGreaterThan(Number(result!.rows[1]['Weight'])); // sorted by weight descending
    const cash = result!.rows.find((row) => row['Name'] === 'Cash & Other')!;
    expect([cash['Market Value'], cash['Weight']]).toEqual(['-3940000', '']);
    expect(calls.filter((url) => url.includes('company_tickers_mf')).length).toBe(1);
    expect(await fallback('SPRE', null, { asOf: null, rows: 0 })).toBeNull(); // another series' filing is rejected, rows are never mixed
    expect(calls.filter((url) => url.includes('company_tickers_mf')).length).toBe(1); // one SEC table load per run
    expect(notes).toEqual(['[ nport    ] SPRE: no N-PORT-P filing of its own: 0002000324-26-004454 names series S000070027, not S000070034']);
  });

  test('the EDGAR fallback refuses a registrant outside the two verified trusts', async () => {
    const transport: Transport = async (url) => {
      if (url.includes('company_tickers')) {
        return new Response(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [['999999', 'S000000001', 'C000000001', 'SPUS']] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    expect(await createEdgarFallback(readConfig({ SEC_UA: 'tests' }), transport, () => {})('SPUS', null, { asOf: null, rows: 0 })).toBeNull();
  });
});
