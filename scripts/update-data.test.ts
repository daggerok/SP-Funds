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
  annualizedFromCumulative, applyUpdaterDefaults, batchSelection, buildCatalog, buildCatalogIndex, yahooHeaders,
  buildPages, catalogIndexEntry, clearCursor, createEdgarFallback, createRequestGate, createTransport,
  cumulativeFromAnnualized, deriveMetrics, edgarSeriesFilingsUrl, errorMessage, fillNportTickers,
  formatAumDisplay, formatMoneyText, formatPercentText, formatUsDate, fundFilterReasons, fundPageUrl,
  holdingsCsvUrl, inferDistributionFrequency, loadUpdaterDefaults, lookupPattern, matchesNportFund,
  matchesRange, mergeDividends, nameValueMap, normalizeHoldingName, normalizeWeightText, nportUrlFor, parseMoneyNumber,
  numberOrNull, outputClean, outputConfigEntries, outputCount, outputCreateReporter, outputFundLine,
  outputMoney, outputPrintFilter, outputScalar, pageFileName, parseAumRange, parseCatalogCards,
  parseCatalogMenu, parseCompanyTickerMap, parseCsv, parseEdgarAtomFilings, parseFundPage,
  parseFundTickerMap, parseHtmlTables, parseNport, parseNportAccessions, parseRange, parseSpFundsHoldingsCsv,
  parseYahooChart, paymentsPerYear, periodKey, readConfig, readCursor, readPreviousIndex, readPreviousPages,
  round, runUpdater, samePublishedContent, sanitizeTicker, secHeaders, selectionEntryFromIndex, splitPages,
  spFundsAssetCategory, stableStringify, toIsoDate, trustForTicker, updateFund, writeIfChanged, writePages,
  writeCursor, clearCursor, entryFromMeta, fundDigest, parseMoneyNumber, publishDistributions, stableContentKey,
  type CatalogFund, type JsonRecord, type SheetRow, type Transport, type UpdaterConfig,
} from './update-data';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/2026-10-01/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

import { readFileSync } from 'node:fs';

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
    const catalog = buildCatalog(fixture('home.html'), []);
    expect(catalog.map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
    expect(catalog.every((fund) => fund.fundPage.startsWith('https://www.sp-funds.com/'))).toBe(true);
  });

  test('the menu link wins over a homepage card that points at a section page', () => {
    const catalog = buildCatalog(fixture('home.html'), []);
    expect(catalog.find((fund) => fund.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    // Cards may use absolute links (the current homepage) or section pages (an earlier one).
    const cards = parseCatalogCards(fixture('home.html'));
    expect(cards.find((card) => card.ticker === 'SPRE')!.fundPage).toBe('https://www.sp-funds.com/spre/');
    const synthetic = `<li><a href="#"><span>Our ETFs</span></a><ul class="sub-menu"><li><a href="/spre/"><span>SPRE</span></a></li></ul></li>
      <div class="bdt-ep-advanced-icon-box-content"><h3 class="bdt-ep-advanced-icon-box-title"><span>SPRE</span></h3>
      <a class="bdt-ep-advanced-icon-box-readmore" href="/spre-2/">See Details</a></div>`;
    const sectionPage = parseCatalogCards(synthetic);
    expect(sectionPage[0].fundPage).toBe('https://www.sp-funds.com/spre-2/');
    expect(buildCatalog(synthetic, [])[0].fundPage).toBe('https://www.sp-funds.com/spre/');
    expect(buildCatalog('<p>no cards</p>', ['SPUS', 'SPWO']).map((fund) => fund.fundPage))
      .toEqual(['https://www.sp-funds.com/spus/', 'https://www.sp-funds.com/spwo/']);
  });

  test('menu parsing ignores the target-date mutual funds and non-fund links', () => {
    const cards = parseCatalogMenu(fixture('home.html'));
    expect(cards.map((card) => card.ticker)).not.toContain('SPTAX');
    expect(cards.length).toBe(5);
    expect(parseCatalogCards(fixture('home.html')).map((card) => card.ticker).sort()).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
  });

  test('an explicit TICKERS selection narrows and extends the catalog, unknown markup falls back to the known lineup', () => {
    expect(buildCatalog(fixture('home.html'), ['SPUS', 'SPWO']).map((fund) => fund.ticker)).toEqual(['SPUS', 'SPWO']);
    const extra = buildCatalog(fixture('home.html'), ['SPUS', 'ZZZZ']);
    expect(extra.map((fund) => fund.ticker)).toEqual(['SPUS', 'ZZZZ']);
    expect(extra.find((fund) => fund.ticker === 'ZZZZ')!.fundPage).toBe('https://www.sp-funds.com/zzzz/');
    // The pinned lineup is published alphabetically.
    expect(buildCatalog('<html>redesigned</html>', []).map((fund) => fund.ticker)).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
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
    expect(chart.days.every((day) => Number(day.close.toFixed(2)) === day.close && Number(day.adjClose.toFixed(2)) === day.adjClose)).toBe(true);
    expect(chart.days.some((day) => day.volume > 0)).toBe(true);
    // Yahoo reports the first trading day, the fund page the inception date.
    expect(chart.firstTradeDate).toBe('2019-12-18');
    expect(chart.exchange).toBe('NYSEArca');
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
    // applyUpdaterDefaults only fills undefined/blank values: a blank default stays blank
    // and the control's own fallback applies during readConfig.
    expect(merged['CONCURRENCY']).toBe('  ');
    expect(readConfig(merged).concurrency).toBe(2);
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
    const config = readConfig({ SEC_UA: 'My Fund Feed (me@example.com)' });
    expect(secHeaders(config)['User-Agent']).toBe('My Fund Feed (me@example.com)');
    expect(yahooHeaders()['User-Agent']).toContain('Mozilla');
    expect(readConfig({}).secUa).toContain('@');
  });
});

// ---------------------------------------------------------------------------
// SEC N-PORT-P fallback
// ---------------------------------------------------------------------------

describe('SEC N-PORT-P fallback', () => {
  const seriesPayload = {
    fields: ['cik', 'seriesId', 'classId', 'symbol'],
    data: [
      ['1742912', 'S000070027', 'C000220954', 'SPUS'],
      ['1742912', 'S000070034', 'C000220961', 'SPRE'],
      ['1989916', 'S000073501', 'C000232134', 'SPTE'],
    ],
  };

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
    const filings = parseNportAccessions(JSON.parse(fixture('edgar-submissions-0001742912.json')));
    expect(filings.length).toBe(40);
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
    const parsed = parseNport(fixture('nport-SPUS.sample.xml'));
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
    const parsed = parseNport(fixture('nport-SPUS.sample.xml'));
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
      if (url.includes('primary_doc.xml')) return new Response(fixture('nport-SPUS.sample.xml'), { status: 200 });
      if (url.includes('company_tickers')) return new Response(JSON.stringify(seriesPayload), { status: 200 });
      return new Response(fixture('edgar-submissions-0001742912.json'), { status: 200 });
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
    const { fetcher } = fixtureFetcher();
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    const outcome = await updateFund(fundFor('SPUS'), offlineConfig({ HOLDINGS_PAGE_SIZE: '25', HISTORY_PAGE_SIZE: '100' }), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));
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
    expect(meta['holdings']).toEqual({ pages: ['001.json', '002.json'], pageSize: 25, totalRows: 40, asOfDate: '2026-10-01' });
    expect(meta['history'].pages.length).toBe(4);
    expect(meta['history'].totalRows).toBe(356);
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
    const { fetcher } = fixtureFetcher();
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
    expect(meta['holdings'].totalRows).toBe(40);
    expect(meta['source']['holdingsSource']).toContain('TidalFG_Holdings_SPUS.csv');
  });

  test('SKIP_SPFUNDS and SKIP_YAHOO keep the published feed untouched', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher, seen } = fixtureFetcher();
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

  test('a fund without a compiled distribution cadence reports none instead of guessing', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = fixtureFetcher({ 'yahoo-SPTE': fixture('yahoo-SPTE.json'), 'csv-SPTE': fixture('TidalFG_Holdings_SPTE.csv') });
    const transport = createTransport(readConfig({ REQUEST_SLEEP: '0' }), async () => {}, fetcher, async () => {});
    const outcome = await updateFund(fundFor('SPTE'), offlineConfig(), apiRoot, transport, null, new Date('2026-10-01T12:00:00Z'));
    expect(outcome.entry['holdings']).toBe(40);
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
    const { fetcher, seen } = fixtureFetcher();
    const first = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T12:00:00Z') });
    expect(first.funds).toBe(5);
    expect(first.holdings).toBe(190);
    expect(first.history).toBe(356 + 302 + 354 + 150 + 147);
    expect(first.failures).toEqual([]);

    const index = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
    expect(index['counts']).toEqual({ funds: 5, holdings: 190, history: 1309 });
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

    seen.length = 0;
    const second = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T18:30:00Z') });
    expect(second.written).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const file of tree) expect(await readFile(new URL(file, apiRoot), 'utf8'), file).toBe(before.get(file));
    const after = await listFiles(apiRoot);
    expect(after).toEqual(tree);
  });

  test('the ticker cursor rotates bounded runs, keeps published funds and resumes only in the same scope', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = fixtureFetcher();
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
    expect(index['funds'].map((fund: JsonRecord) => fund['ticker'])).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
    // Funds processed earlier in the sweep still carry their rows.
    expect(index['funds'][0]['holdings']).toBe(30); // SPRE ran first in the sweep
    expect(index['funds'][2]['holdings']).toBe(0); // SPTE still has its placeholder row

    const full = await runUpdater(offlineConfig(), { apiRoot, fetcher, now: new Date('2026-10-01T13:00:00Z') });
    expect(full.funds).toBe(5);
    // A full pass clears the cursor again.
    expect(await readCursor(apiRoot)).toBeNull();
  });

  test('filters keep out funds whose published facts fall outside the range', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = fixtureFetcher();
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
    expect(lines.some((line) => line.includes('SPRE  skipped'))).toBe(true);
    expect(lines.some((line) => line.startsWith('[ done     ] counts:') && line.includes('holdings=190'))).toBe(true);
    const after = JSON.parse(await readFile(new URL('index.json', apiRoot), 'utf8'));
    // Skipped funds keep their published entry: the feed never shrinks silently.
    expect(after['funds'].length).toBe(5);
    expect(after['funds'].map((fund: JsonRecord) => fund['ticker'])).toEqual(['SPRE', 'SPSK', 'SPTE', 'SPUS', 'SPWO']);
  });

  test('a fund that throws is reported and does not stop the run', async () => {
    const apiRoot = await tempApiRoot();
    const { fetcher } = fixtureFetcher();
    const originalYahoo = 'query1.finance.yahoo.com/v8/finance/chart/SPUS';
    const exploding = async (url: string): Promise<Response> => {
      if (url.includes(originalYahoo)) throw new Error('yahoo is down');
      return fetcher(url);
    };
    const summary = await runUpdater(offlineConfig({ MAX_RETRIES: '0' }), { apiRoot, fetcher: exploding as unknown as typeof fetch, now: new Date('2026-10-01T12:00:00Z') });
    expect(summary.funds).toBe(5);
    expect(summary.failures).toEqual([]);
    const meta = JSON.parse(await readFile(new URL('funds/SPUS/meta.json', apiRoot), 'utf8'));
    expect(meta['history'].totalRows).toBe(0); // first run, nothing published to retain
    expect(meta['holdings'].totalRows).toBe(40);
    expect(meta['source']['historySource']).toContain('yahoo');
  });

  test('the catalog index carries the provider, trust and per-fund provenance', () => {
    const funds = buildCatalog(fixture('home.html'), []);
    const index = buildCatalogIndex('SP Funds', funds, 190, 1309, '2026-10-01T00:00:00.000Z');
    expect(index['counts']).toEqual({ funds: 5, holdings: 190, history: 1309 });
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
