/// <reference types="bun" />
/**
 * Offline tests for the SP Funds feed updater. Every fixture under
 * scripts/fixtures/2026-10-01/ is a trimmed copy of the real 2026-10-01 capture
 * (research/2026-10-01/capture-log.txt records the fetched bytes); trimming only
 * drops rows beyond 40 in very long tables and shrinks the document tiles, and
 * the parsed fund-page fields were verified identical against the full capture.
 * No test performs network I/O.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_ROOT, HISTORY_HEADERS, HOLDINGS_HEADERS, SPFUNDS_TRUST, TIDAL_TRUST, USAGE,
  annualizedFromCumulative, applyUpdaterDefaults, batchSelection, buildCatalog, buildCatalogIndex,
  buildPages, catalogIndexEntry, createEdgarFallback, createRequestGate, createTransport,
  cumulativeFromAnnualized, deriveMetrics, edgarSeriesFilingsUrl, errorMessage, fillNportTickers,
  formatAumDisplay, formatMoneyText, formatPercentText, formatUsDate, fundFilterReasons, fundPageUrl,
  holdingsCsvUrl, inferDistributionFrequency, loadUpdaterDefaults, lookupPattern, matchesNportFund,
  matchesRange, mergeDividends, nameValueMap, normalizeHoldingName, normalizeWeightText, nportUrlFor,
  numberOrNull, outputClean, outputConfigEntries, outputCount, outputCreateReporter, outputFundLine,
  outputMoney, outputPrintFilter, outputScalar, pageFileName, parseAumRange, parseCatalogCards,
  parseCatalogMenu, parseCompanyTickerMap, parseCsv, parseEdgarAtomFilings, parseFundPage,
  parseFundTickerMap, parseHtmlTables, parseNport, parseNportAccessions, parseRange, parseSpFundsHoldingsCsv,
  parseYahooChart, paymentsPerYear, periodKey, readConfig, readCursor, readPreviousIndex, readPreviousPages,
  round, runUpdater, samePublishedContent, sanitizeTicker, secHeaders, selectionEntryFromIndex, splitPages,
  spFundsAssetCategory, stableStringify, toIsoDate, trustForTicker, updateFund, writeIfChanged, writePages,
  writeCursor,
  type CatalogFund, type ChartDay, type FundOutcome, type JsonRecord, type SheetRow, type Transport,
  type UpdaterConfig,
} from './update-data';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/2026-10-01/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const fixtureBytes = (name: string): Uint8Array => readFileSync(new URL(name, FIXTURES));
const exists = (name: string): boolean => existsSync(new URL(name, FIXTURES));

import { existsSync, readFileSync } from 'node:fs';

const TICKERS = ['SPUS', 'SPRE', 'SPSK', 'SPTE', 'SPWO'];

/** Routes every outbound URL of an offline run to the captured 2026-10-01 bytes. */
function fixtureRoutes(overrides: Record<string, string> = {}): Array<[RegExp, () => string]> {
  return [
    [/^https:\/\/www\.sp-funds\.com\/$/, () => overrides['home'] ?? fixture('home.html')],
    [/^https:\/\/www\.sp-funds\.com\/([a-z]+)\/$/, (match) => overrides[match[1]] ?? fixture(`${match[1].toUpperCase()}.page.html`)],
    [/TidalFG_Holdings_([A-Z]+)\.csv$/, (match) => overrides[`csv-${match[1]}`] ?? fixture(`TidalFG_Holdings_${match[1]}.csv`)],
    [/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([A-Z]+)/, (match) => overrides[`yahoo-${match[1]}`] ?? fixture(`yahoo-${match[1]}.json`)],
    [/data\.sec\.gov\/submissions\/CIK0001742912/, () => overrides['tidal'] ?? fixture('edgar-submissions-0001742912.json')],
    [/data\.sec\.gov\/submissions\/CIK0001989916/, () => overrides['spfunds'] ?? fixture('edgar-submissions-0001989916.json')],
    [/company_tickers_mf\.json/, () => overrides['series'] ?? fixture('sec-company_tickers_mf.json')],
    [/browse-edgar/, () => overrides['atom'] ?? '<feed></feed>'],
    [/primary_doc\.xml$/, () => overrides['nport'] ?? ''],
  ] as unknown as Array<[RegExp, () => string]>;
}

function fixtureFetcher(overrides: Record<string, string> = {}) {
  const seen: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    seen.push(url);
    for (const [pattern, body] of fixtureRoutes(overrides)) {
      const match = pattern.exec(url);
      if (match) return new Response(body(match as unknown as RegExpExecArray), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetcher: fetcher as unknown as typeof fetch, seen };
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

// ---------------------------------------------------------------------------
// Numeric and date parsing
// ---------------------------------------------------------------------------

describe('numeric and date parsing', () => {
  test('retains zero, negatives, parentheses, currency and percentages; rejects placeholders', () => {
    expect(['0', 0, '-1.25%', '($1,234.5)', ' $2,500.25 ', '$3.28B', null, undefined, '', ' ', '—', '–', '--', 'N/A', 'garbage'].map(numberOrNull))
      .toEqual([0, 0, -1.25, -1234.5, 2500.25, 3.28, null, null, null, null, null, null, null, null, null]);
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
    const catalog = buildCatalog(fixture('home.html'), []);
    expect(catalog.map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
    expect(catalog.every((fund) => fund.fundPage.startsWith('https://www.sp-funds.com/'))).toBe(true);
  });

  test('the menu link wins over a homepage card that points at a section page', () => {
    const catalog = buildCatalog(fixture('home.html'), []);
    const spre = catalog.find((fund) => fund.ticker === 'SPRE')!;
    // The homepage card links /spre-2/; the fund page is /spre/.
    expect(spre.fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(fixture('home.html')).toContain('/spre-2/');
  });

  test('menu parsing ignores the target-date mutual funds and non-fund links', () => {
    const cards = parseCatalogMenu(fixture('home.html'));
    expect(cards.map((card) => card.ticker)).not.toContain('SPTAX');
    expect(cards.length).toBe(5);
    expect(parseCatalogCards(fixture('home.html')).map((card) => card.ticker)).toEqual(['SPUS', 'SPSK', 'SPRE', 'SPTE', 'SPWO']);
  });

  test('an explicit TICKERS selection narrows and extends the catalog, unknown markup falls back to the known lineup', () => {
    expect(buildCatalog(fixture('home.html'), ['SPUS', 'SPWO']).map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    const extra = buildCatalog(fixture('home.html'), ['SPUS', 'ZZZZ']);
    expect(extra.map((fund) => fund.ticker)).toEqual(['SPUS', 'ZZZZ']);
    expect(extra.find((fund) => fund.ticker === 'ZZZZ')!.fundPage).toBe('https://www.sp-funds.com/zzzz/');
    expect(buildCatalog('<html>redesigned</html>', []).map((fund) => fund.ticker)).toEqual(TICKERS);
  });
});

// ---------------------------------------------------------------------------
// Fund pages
// ---------------------------------------------------------------------------

describe('official fund pages', () => {
  const page = parseFundPage(fixture('SPUS.page.html'), 'SPUS');

  test('SPUS: official legal name, identifiers and pricing from the two-column tables', () => {
    expect(page.name).toBe('SP Funds S&P 500 Sharia Industry Exclusions ETF');
    expect(lookupPattern(page.details, /fund inception/i)).toBe('12/17/2019');
    expect(lookupPattern(page.details, /cusip/i)).toBe('886364801');
    expect(lookupPattern(page.details, /primary exchange/i)).toBe('NYSE');
    expect(lookupPattern(page.details, /expense ratio/i)).toBe('0.45%');
    expect(lookupPattern(page.details, /sec yield/i)).toBe('0.40%');
    expect(lookupPattern(page.pricing, /^nav$/i)).toBe('59.54');
    expect(lookupPattern(page.pricing, /net assets/i)).toBe('3274.89');
    expect(lookupPattern(page.pricing, /shares outstanding/i)).toBe('55000000');
    expect(lookupPattern(page.pricing, /premium\/?discount/i)).toBe('-0.01%');
    expect(lookupPattern(page.pricing, /closing price/i)).toBe('59.54');
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
    expect(page.distributions.length).toBeGreaterThanOrEqual(39);
    expect(page.distributions[0]).toEqual({ exDate: '2026-09-28', recordDate: '2026-09-28', payDate: '2026-09-29', amount: 0.026 });
    expect(page.distributions[1].exDate).toBe('2026-08-26');
    expect(page.distributions.every((row) => row.amount !== null)).toBe(true);
  });

  test('SPTE: month-end and quarter-end tables differ and a young fund keeps its published zero', () => {
    const spte = parseFundPage(fixture('SPTE.page.html'), 'SPTE');
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

  test('every captured fund page parses without an empty identity', () => {
    for (const ticker of TICKERS) {
      const parsed = parseFundPage(fixture(`${ticker}.page.html`), ticker);
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
  const parsed = parseSpFundsHoldingsCsv(fixture('TidalFG_Holdings_SPUS.csv'));

  test('SPUS: 40 captured positions map onto the shared holdings contract', () => {
    expect(parsed.headers).toEqual(HOLDINGS_HEADERS);
    expect(parsed.rows.length).toBe(40);
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
    const spre = parseSpFundsHoldingsCsv(fixture('TidalFG_Holdings_SPRE.csv'));
    const cash = spre.rows.find((row) => row['Asset Category'] === 'Cash')!;
    expect(cash.Ticker).toBe('Cash&Other');
    expect(Number(cash.Weight.replace('%', ''))).toBeLessThan(0);
    expect(spre.rows.some((row) => / AU$| MK$| PM$| TB$| UH$| TI$/.test(row.Ticker))).toBe(true);
  });

  test('quoting, BOM, CRLF and truncated files are handled without inventing rows', () => {
    const rows = parseCsv('\uFEFFa,b,c\r\n"x, y",2,"say ""hi"""\r\n1,2,3\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', '2', 'say "hi"'], ['1', '2', '3']]);
    expect(parseSpFundsHoldingsCsv('').rows).toEqual([]);
    expect(() => parseSpFundsHoldingsCsv('Date,Weird\n1,2\n')).toThrow('StockTicker');
    // A truncated download must not turn the partial tail into a position.
    const truncated = fixture('TidalFG_Holdings_SPUS.csv').split('\n').slice(0, 12).join('\n');
    expect(parseSpFundsHoldingsCsv(truncated).rows.length).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Yahoo Finance
// ---------------------------------------------------------------------------

describe('Yahoo chart feed', () => {
  const chart = parseYahooChart(JSON.parse(fixture('yahoo-SPUS.json')));

  test('SPUS: whole daily series, newest first, adjusted closes rounded to cents', () => {
    expect(chart.days.length).toBe(356);
    expect(chart.days[0].date >= chart.days[1].date).toBe(true);
    expect(chart.days.every((day) => Number.isInteger(day.close * 100) && Number.isInteger(day.adjClose * 100))).toBe(true);
    expect(chart.days.some((day) => day.volume > 0)).toBe(true);
    expect(chart.firstTradeDate).toBe('2019-12-17');
    expect(chart.exchange).toBe('NYSE');
  });

  test('dividends are newest first and keep Yahoo epochs', () => {
    expect(chart.dividends.length).toBe(77);
    expect(chart.dividends[0].exDate >= chart.dividends[1].exDate).toBe(true);
    expect(chart.dividends[0].epoch).toBeGreaterThan(chart.dividends[0].epoch - 1);
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
  test('the checked-in JSON is the runtime default and every key is a canonical control', () => {
    const defaults = loadUpdaterDefaults();
    expect(defaults['MAX_FETCHES']).toBe('0');
    expect(defaults['CONCURRENCY']).toBe('2');
    expect(defaults['REQUEST_SLEEP']).toBe('1');
    expect(Object.keys(defaults).length).toBeGreaterThanOrEqual(25);
    expect(defaults['SEC_UA']).toContain('SP-Funds');
    const config = readConfig(applyUpdaterDefaults(defaults));
    expect(config.tickers).toEqual([]);
    expect(config.historyRange).toBe('max');
    expect(config.edgarFallback).toBe(true);
    expect(config.aumRange).toBeUndefined(); // ":" disables
    expect(config.performanceRanges).toEqual({});
  });

  test('a nonblank environment value always wins; blank values take the JSON default', () => {
    const merged = applyUpdaterDefaults({ MAX_FETCHES: '2', CONCURRENCY: '  ', TICKERS: 'spus,spwo' }, { MAX_FETCHES: '9', CONCURRENCY: '', HOLDINGS_PAGE_SIZE: '50' });
    expect(merged['MAX_FETCHES']).toBe('9');
    expect(merged['CONCURRENCY']).toBe('2');
    expect(merged['HOLDINGS_PAGE_SIZE']).toBe('50');
    expect(merged['TICKERS']).toBe('spus,spwo');
    const config = readConfig(merged);
    expect(config.tickers).toEqual(['SPUS', 'SPWO']);
    expect(config.maxFetches).toBe(9);
    expect(config.holdingsPageSize).toBe(50);
  });

  test('explicit zero and false are honoured, invalid numbers fall back', () => {
    const config = readConfig({ MAX_FETCHES: '0', CONCURRENCY: '0', REQUEST_SLEEP: '0', SKIP_YAHOO: 'false', EDGAR_FALLBACK: '0', MAX_RETRIES: 'x' });
    expect(config.maxFetches).toBe(0);
    expect(config.concurrency).toBe(2);
    expect(config.requestSleep).toBe(0);
    expect(config.skipYahoo).toBe(false);
    expect(config.edgarFallback).toBe(false);
    expect(config.maxRetries).toBe(2);
    expect(readConfig({ REQUEST_SLEEP: '0.5' }).requestSleep).toBe(0.5);
  });

  test('ranges and AUM presets', () => {
    expect(parseRange('1:5')).toEqual({ min: 1, max: 5 });
    expect(parseRange(':5')).toEqual({ min: 0, max: 5 });
    expect(parseRange('2:')).toEqual({ min: 2, max: Infinity });
    expect(parseRange(':')).toBeUndefined();
    expect(parseRange('nonsense')).toBeUndefined();
    expect(parseAumRange('mid')).toEqual({ min: 2e9, max: 1e10, source: 'mid' });
    expect(parseAumRange('500M:2B')).toEqual({ min: 5e8, max: 2e9, source: '500M:2B' });
    const config = readConfig({ AUM: '1B:', TER: '0:0.5', PERFORMANCE_1Y: '0:100', TOTAL_RETURN_3Y: ':', SEC_YIELD: '0.4:5' });
    expect(config.aumRange!.min).toBe(1e9);
    expect(config.terRange!.max).toBe(0.5);
    expect(config.performanceRanges['1Y']).toEqual({ min: 0, max: 100 });
    expect(config.totalReturnRanges['3Y']).toBeUndefined();
    expect(config.secYieldRange!.min).toBe(0.4);
  });

  test('--help documents every control', () => {
    for (const key of ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'TICKERS', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_<P>', 'TOTAL_RETURN_<P>', 'HISTORY_RANGE', 'EDGAR_FALLBACK', 'SKIP_SPFUNDS', 'SKIP_YAHOO', 'SEC_UA', 'VERBOSE']) {
    expect(USAGE).toContain(key);
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
    const catalog = buildCatalog(fixture('home.html'), []);
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
  test('the bracket is nine characters wide and always present', () => {
    const line = outputFundLine(1, 5, 'SPUS', 'ok', { history: 356, holdings: 219, distributions: 'Monthly', netAssets: 3283824025, dividendYield: '0.52%', secYield: '0.40%' });
    expect(line.startsWith('[      1/5 ] SPUS  ok')).toBe(true);
    expect(line).toContain('history=356');
    expect(line).toContain('holdings=219');
    expect(line).toContain('div=Monthly');
    expect(line).toContain('netAssets=$3.28B');
    expect(line).toContain('div=0.52%');
    expect(line).toContain('sec=0.40%');
    expect(outputFundLine(12, 12, 'SPWO', 'ok').startsWith('[    12/12 ] SPWO  ok')).toBe(true);
  });

  test('null-ish fields are omitted, zero and false are preserved, long reasons are flattened', () => {
    const line = outputFundLine(2, 5, 'SPRE', 'FAILED', { history: 0, holdings: null }, 'retained: holdings\nissuer page');
    expect(line).toContain('history=0');
    expect(line).not.toContain('holdings=');
    expect(line).toContain('reason=retained: holdings issuer page');
    expect(line.includes('\n')).toBe(false);
    expect(outputCount([])).toBe(0);
    expect(outputCount({ totalRows: 400 })).toBe(400);
    expect(outputScalar({ display: '$3.28B' })).toBe('$3.28B');
    expect(outputMoney(453_000_000)).toBe('$453.00M');
    expect(outputMoney(null)).toBeNull();
    expect(outputClean('a\tb\nc')).toBe('a b c');
  });

  test('the reporter numbers the processed funds in order', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { lines.push(String(value)); };
    try {
      const reporter = outputCreateReporter(2);
      reporter.result('SPUS', 'ok', { holdings: 40 });
      reporter.result('SPWO', 'ok', { holdings: 40 });
    } finally {
      console.log = original;
    }
    expect(lines[0].startsWith('[      1/2 ] SPUS  ok')).toBe(true);
    expect(lines[1].startsWith('[      2/2 ] SPWO  ok')).toBe(true);
  });

  test('config output prints canonical names, redacts secrets and is stable', () => {
    const config = readConfig(applyUpdaterDefaults(loadUpdaterDefaults()));
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
    const previous = await readPreviousPages(holdingsDir);
    expect(previous.headers).toEqual(HOLDINGS_HEADERS);
    expect(previous.rows).toEqual(rows.slice(0, 2));
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
    const started: number[] = [];
    const gate = createRequestGate(2, 1000, () => clock, async (ms: number) => { clock += ms; });
    const wait = (async () => { started.push(clock); })();
    await gate();
    await gate();
    await gate();
    await wait;
    expect(started.length).toBe(1);
    expect(clock).toBe(0);
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
    const config = readConfig({ SEC_UA: 'My Fund Feed (me@example.com)' });
    expect(secHeaders(config)['User-Agent']).toBe('My Fund Feed (me@example.com)');
    expect(yahooHeaders()['User-Agent']).toContain('Mozilla');
    expect(readConfig({}).secUa).toContain('@');
  });
});
