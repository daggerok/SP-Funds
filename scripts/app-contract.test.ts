/// <reference types="bun" />
/**
 * Parity guards for the copied client app (index.html + app.tsx are a sibling
 * copy with only the enumerated string substitutions) and for the data contract
 * the UI reads from the generated api/spfunds feed.
 *
 * The UI files are checked as text: brand tokens must be gone, the mandatory
 * header summary panel and the frequency fallback must be present, and the one
 * extracted pure function that carries a mandatory display rule is executed.
 * The feed is generated offline from scripts/fixtures/2026-10-01/ so the test
 * never touches the network.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_HEADERS, HOLDINGS_HEADERS, readConfig, runUpdater } from './update-data';

const FIXTURES = new URL('./fixtures/2026-10-01/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const TICKERS = ['SPUS', 'SPRE', 'SPSK', 'SPTE', 'SPWO'];

/** Routes every outbound URL of an offline run to the captured 2026-10-01 bytes. */
const fixtureFetcher = async (url: string): Promise<Response> => {
  const routes: Array<[RegExp, () => string]> = [
    [/^https:\/\/www\.sp-funds\.com\/$/, () => fixture('home.html')],
    [/^https:\/\/www\.sp-funds\.com\/([a-z]+)\/$/, (match) => fixture(`${match[1].toUpperCase()}.page.html`)],
    [/TidalFG_Holdings_([A-Z]+)\.csv$/, (match) => fixture(`TidalFG_Holdings_${match[1]}.csv`)],
    [/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([A-Z]+)/, (match) => fixture(`yahoo-${match[1]}.json`)],
    [/company_tickers_mf\.json/, () => '{"fields":[],"data":[]}'],
    [/browse-edgar/, () => '<feed></feed>'],
    [/primary_doc\.xml$/, () => ''],
  ];
  for (const [pattern, body] of routes) {
    const match = pattern.exec(url);
    if (match) return new Response((body as unknown as (m: string[]) => string)(match), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

/** Runs the extracted `formatDividendFrequency` through Bun's TS transpiler. */
function extractedFrequencyFunction(): (value: unknown) => string {
  const start = app.indexOf('function formatDividendFrequency');
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf('\n}', start);
  const source = app.slice(start, end + 2);
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`(() => { ${source} return formatDividendFrequency; })()`);
  return new Function(`return ${js}`)() as (value: unknown) => string;
}

describe('client shell parity (index.html)', () => {
  test('brand title, subtitle and API links point at SP Funds', () => {
    expect(html).toContain('<title>SP Funds ETFs</title>');
    expect(html).toContain('>SP Funds ETFs</h1>');
    expect(html).toContain('Search SP Funds ETFs, select ETFs via the “Use” checkbox');
    expect(html).toContain('./api/spfunds/index.json');
    expect(html).toContain('href="https://www.sp-funds.com/"');
  });

  test('the hidden count-badge summary panel and its behavior script are the sibling ones', () => {
    expect(html).toContain('id="catalog-summary-styles"');
    expect(html).toContain('id="ticker-count"');
    expect(html).toContain('aria-controls="app-summary"');
    expect(html).toContain('id="app-summary"');
    expect(html).toContain('id="catalog-summary-behavior"');
    expect(html).toContain('Escape');
  });

  test('no other issuer, site or source token survives the copy', () => {
    expect(html).not.toMatch(/xtrackers|etf\.dws\.com|DBX ETF TRUST|XLSX/i);
    expect(app).not.toMatch(/xtrackers|etf\.dws\.com|DBX ETF TRUST/i);
    expect(html).toContain('Tidal Trust I, CIK 0001742912 / SP Funds Trust, CIK 0001989916');
    expect(app).toContain('Tidal Trust I, CIK 0001742912 / SP Funds Trust, CIK 0001989916');
  });
});

describe('client app parity (app.tsx)', () => {
  test('feed paths, storage keys and the export prefix are re-branded', () => {
    expect(app).toContain("const INDEX_URL = './api/spfunds/index.json';");
    for (const key of ['theme', 'selected-etfs', 'blacklisted-etfs', 'active-fund', 'tab-filters', 'searches', 'tab-sorts', 'site-state']) {
      expect(app).toContain(`'spfunds-${key}'`);
    }
    expect(app).toContain('`spfunds-${scope.toLowerCase()');
  });

  test('rows stay selectable only through the Use checkbox', () => {
    // The sibling fix: no click handler on a table row, only on the checkbox.
    expect(app).not.toMatch(/<tr[^>]*onclick/i);
    expect(app).not.toMatch(/tableBody\.addEventListener\('click'/);
    expect(app).toContain('id="select-all-checkbox"');
  });

  test('the mandatory frequency fallback displays 00 - None for empty values', () => {
    const format = extractedFrequencyFunction();
    expect([null, undefined, '', '   ', '—', '–', '-', 'none', 'None'].map(format))
      .toEqual(['00 - None', '00 - None', '00 - None', '00 - None', '00 - None', '00 - None', '00 - None', '00 - None', '00 - None']);
    expect(format('monthly')).toBe('01 - Monthly');
    expect(format('Quarterly')).toBe('04 - Quarterly');
    expect(format('semi-annually')).toBe('06 - Semi-annually');
    expect(format('Annually')).toBe('12 - Annually');
    expect(format('unknown')).toBe('00 - Unknown');
    expect(format('irregular')).toBe('99 - Irregular');
    expect(format('Unicorn')).toBe('Unicorn');
  });

  test('the header badge and its rich panel render the selection as tickers only', () => {
    expect(app).toContain('function renderHeaderSummary(');
    expect(app).toContain('`${selected.length} selected: `');
    expect(app).toContain("link.dataset.headerFund = ticker;");
    expect(app).toContain('renderHeaderSummary(el.subtitle, state.selected, state.activeFundTicker, activateFund);');
  });
});

describe('README structure', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const headings = readme
    .split('\n')
    .filter((line) => !line.startsWith('```'))
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.trim());

  test('the pinned sibling section order is preserved', () => {
    const expected = [
      '# SP Funds',
      '## Using Bun',
      '## Updating the static SP Funds data',
      '### Data sources',
      '### Update controls',
      '### Examples',
      '## TypeScript',
      '## Brands table',
      '## Sibling applications',
      '## License',
    ];
    for (const heading of expected) expect(headings).toContain(heading);
    expect(headings.filter((line) => line.startsWith('## '))).toEqual(
      ['## Using Bun', '## Updating the static SP Funds data', '## TypeScript', '## Brands table', '## Sibling applications', '## License'],
    );
  });

  test('documented controls and examples exist in the implementation', () => {
    const defaults = JSON.parse(readFileSync(new URL('./update-data.config.json', import.meta.url), 'utf8'));
    for (const key of Object.keys(defaults)) {
      if (key === 'TICKERS' || key === 'SEC_UA') continue; // documented as "all" / "declared UA"
      expect(readme).toContain(`| \`${key}\` |`);
    }
    const examples = [...readme.matchAll(/^([A-Z_]+)="([^"]*)" \.\/scripts\/update-data\.ts$/gm)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const name of examples) expect(defaults).toHaveProperty(name);
  });

  test('brand and sibling tables carry the SP Funds rows and the sibling family', () => {
    expect(readme).toMatch(/\| \*\*SP Funds\*\* \| \[sp-funds\.com\]\(https:\/\/www\.sp-funds\.com\/\)/);
    expect(readme).toMatch(/\| SP Funds \| .* \| \[SP-Funds\]\(https:\/\/github\.com\/daggerok\/SP-Funds\) \|/);
    for (const sibling of ['Xtrackers', 'NEOS', 'WisdomTree', 'SPDR', 'SP Funds']) {
      expect(readme).toContain(`| **${sibling}** |`);
    }
  });
});

describe('generated feed contract', () => {
  test('index entries and fund meta carry every field the copied UI reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spfunds-contract-'));
    const apiRoot = new URL(`file://${dir}/api/spfunds/`);
    const summary = await runUpdater(readConfig({ TICKERS: TICKERS.join(' '), REQUEST_SLEEP: '0', CONCURRENCY: '4', SEC_UA: 'tests' }), {
      apiRoot, fetcher: fixtureFetcher as unknown as typeof fetch, catalogHtml: fixture('home.html'),
    });
    expect(summary.failures).toEqual([]);

    const index = JSON.parse(readFileSync(new URL('index.json', apiRoot), 'utf8'));
    expect(Object.keys(index).sort()).toEqual(['counts', 'funds', 'generatedAt', 'provider', 'source']);
    expect(index.counts.funds).toBe(5);
    const entry = index.funds.find((fund: Record<string, unknown>) => fund.ticker === 'SPUS')!;
    for (const key of [
      'ticker', 'name', 'category', 'fundPage', 'dataFile', 'ter', 'terValue', 'nav', 'navValue',
      'aum', 'aumValue', 'asOfDate', 'inceptionDate', 'exchange', 'closePrice', 'closePriceAsOfDate',
      'premiumDiscount', 'cusip', 'isin', 'distributions', 'returns', 'metrics', 'holdings', 'history',
    ]) {
      expect(entry).toHaveProperty(key);
    }
    for (const key of ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'secYield', 'dividendYieldText', 'secYieldText']) {
      expect(entry.metrics).toHaveProperty(key);
    }
    for (const key of ['asOfDate', 'ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']) {
      expect(entry.returns.monthEnd).toHaveProperty(key);
      expect(entry.returns.quarterEnd).toHaveProperty(key);
    }

    const meta = JSON.parse(readFileSync(new URL('funds/SPUS/meta.json', apiRoot), 'utf8'));
    for (const key of ['identifiers', 'source', 'yields', 'holdings', 'history', 'distributions', 'performance', 'documents', 'returns', 'metrics']) {
      expect(meta).toHaveProperty(key);
    }
    expect(meta.identifiers).toHaveProperty('cusip');
    expect(meta.identifiers).toHaveProperty('isin');
    expect(meta.identifiers).toHaveProperty('indexTicker');
    for (const key of ['provider', 'holdingsSource', 'historySource', 'distributionsSource']) {
      expect(meta.source).toHaveProperty(key);
    }
    for (const key of ['secYieldText', 'secYieldKind', 'dividendYieldKind']) {
      expect(meta.yields).toHaveProperty(key);
    }
    expect(meta.holdings.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.distributions.headers).toEqual(['Ex-Date', 'Record Date', 'Payable Date', 'Amount']);
    expect(meta.distributions.rows.length).toBeGreaterThan(0);

    const holdings = JSON.parse(readFileSync(new URL('funds/SPUS/holdings/001.json', apiRoot), 'utf8'));
    expect(holdings.headers).toEqual(HOLDINGS_HEADERS);
    expect(holdings.page).toBe(1);
    expect(holdings.totalRows).toBe(40);
    expect(Object.keys(holdings.rows[0])).toEqual(HOLDINGS_HEADERS);
    const history = JSON.parse(readFileSync(new URL('funds/SPUS/history/001.json', apiRoot), 'utf8'));
    expect(history.headers).toEqual(HISTORY_HEADERS);
    expect(history.totalRows).toBe(356);
    expect(history.rows.length).toBe(356);
  });
});
