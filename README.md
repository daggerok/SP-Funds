# SP Funds

One of the app's features lets you select SP Funds ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/spfunds` static feed (official sp-funds.com homepage catalog and per-fund pages - legal name, identifiers, pricing, month-end/quarter-end returns, distribution history and document links - plus each fund's published daily holdings CSV, with SEC EDGAR N-PORT-P as a holdings fallback and Yahoo Finance daily prices/history/dividend fallbacks) into a searchable ETF catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/SP-Funds#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The application is live at <https://daggerok.github.io/SP-Funds/> (GitHub Pages serves the `main` branch).

## Updating the static SP Funds data

Run the updater with Bun:

```bash
bun test
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

Defaults live in `scripts/update-data.config.json` (every control as a string). Precedence: file defaults < advanced JSON < nonblank individual inputs < protected Actions variable/environment. An explicitly set environment variable always wins, even when empty, and invalid values fail with a clear message instead of falling back silently. The **Update SP Funds ETF data** GitHub Actions workflow runs on Sundays at 00:00 UTC and on demand, and resolves controls with the same `resolveControls` function as the CLI: individual `workflow_dispatch` inputs are blank by default and inherit the file, and the `advanced` input accepts a JSON object with any control (for example `{"EDGAR_FALLBACK":"false","VERBOSE":"true"}`; GitHub allows at most 25 inputs). The updater only writes below `api/spfunds`. All supplied filters use **AND** logic, and pacing stays polite at 1 second per lane with 2 lanes because sp-funds.com is not WAF-protected.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all five SP Funds ETFs) | Official [sp-funds.com](https://www.sp-funds.com/) "Our ETFs" homepage menu - SPUS, SPRE, SPSK, SPTE, SPWO; a built-in five-fund lineup is retained if the homepage markup changes. |
| Holdings per fund | Official daily CSV `https://www.sp-funds.com/wp-content/uploads/data/TidalFG_Holdings_{TICKER}.csv` (`Date, Account, StockTicker, CUSIP, SecurityName, Shares, Price, MarketValue, Weightings, NetAssets, SharesOutstanding, CreationUnits`); e.g. [SPUS](https://www.sp-funds.com/wp-content/uploads/data/TidalFG_Holdings_SPUS.csv). |
| Fund page facts | `https://www.sp-funds.com/<ticker-lowercase>/`: Fund Details (inception, primary exchange, CUSIP, expense ratio, 30-day SEC yield), Fund Details & Pricing (NAV, net assets, shares outstanding, premium/discount, closing price), Performance Statistics (Month-End and Quarter-End tables), Distribution Details and the documents block. The homepage menu link wins over a homepage card that points at a section page. |
| Daily history, distributions | Yahoo Finance chart API (daily close/adjusted close/volume and dividends, adjusted closes rounded to two decimals); the fund page's Distribution Details table supplies the published distribution calendar and frequency when present. |
| Fallback | SEC EDGAR N-PORT-P holdings only ([Tidal Trust I](https://data.sec.gov/submissions/CIK0001742912.json), CIK `0001742912`, for SPUS/SPRE/SPSK; [SP Funds Trust](https://data.sec.gov/submissions/CIK0001989916.json), CIK `0001989916`, for SPTE/SPWO - exact series/registrant matching) + previously published data as the last resort. |

SEC endpoints have answered HTTP 403 to GitHub-hosted runners, so the N-PORT-P fallback is exercised offline against a small inline sample and is used only when the issuer's daily CSV is unavailable. Yahoo's adjusted close is recomputed server-side and can move by one cent between otherwise identical requests, so a repeat run may rewrite a history page without any other change.

### Metrics and caveats

- Holdings come from the issuer's own daily CSV, which publishes no asset-class column; the Watchlist category is derived from the row itself (cash lines Cash, options Option, fund units Fund, everything else Equity). Cash cushions keep the provider's negative weight and value
- SPRE holds foreign listings; their exchange-suffixed tickers (for example `GMG AU`) are kept as published
- Returns are the official month-end NAV figures as published (3Y/5Y/10Y annualized); cumulative figures are derived from them. A young fund keeps its published `0.00`, while a `-` is unavailable and stays empty rather than becoming 0
- Daily history, closing prices beyond the page's own close and dividends are Yahoo Finance market data; the distribution calendar, frequency and indicated yield are derived estimates, not issuer-reported yields. Official NAV, net assets and the 30-day SEC yield come from the fund page with their as-of dates
- `HISTORY_RANGE` narrows the Yahoo request window; the published history then covers only that window
- No ticker exclusions: the five ETFs are the lineup; the site's six target-date mutual funds are out of scope

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official NAV YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - official annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized NAV return when the site publishes it
- `dividendYield` - indicated distribution rate (latest distribution × frequency ÷ NAV) when the page publishes no explicit rate; `—` otherwise
- `secYield` - 30-day SEC yield when published; `—` otherwise
- `returnsBasis` - mandatory non-empty label of how the returns are computed: here always the official SP Funds month-end NAV total returns from the fund page performance table, with the cumulative 3/5/10-year figures derived from the published annualized ones
- `performanceAsOf` - mandatory ISO `YYYY-MM-DD` date of that performance table (the month-end `Date` column), not the NAV date; `null` only when the table date is unknown. Both fields are the last two keys of `metrics`

### Update controls

Defaults below are from `scripts/update-data.config.json`; blank Actions inputs do not override them. The individual workflow inputs cover every control except `SEC_UA`, `EDGAR_FALLBACK`, `VERBOSE` and `USE_SYSTEM_CA`, which are set through `advanced`.

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch evaluation size: positive resumes the scoped cursor in `api/spfunds/update-state.json`; `0` is a full selected pass. A failed fund prevents cursor advancement |
| `REQUEST_SLEEP` | `1` | Minimum seconds between outgoing request starts in each independent lane, including retries |
| `CONCURRENCY` | `2` | Parallel fund workers (integer >= 1), each with its own paced request lane. `CONCURRENCY=15 ./scripts/update-data.ts` fetches up to 15 funds at once; the lineup has five funds, so at most five run together |
| `TICKERS` | all | Space/comma/semicolon allowlist, e.g. SPUS SPSK SPTE. Unknown requested tickers fail before writes |
| `AUM` | `:` | Net Assets range: USD amounts or K/M/B/T suffixes; nano/micro/small/mid/large presets; inclusive min:max |
| `TER` | `:` | Gross expense ratio range in % (strict min:max) |
| `DIVIDEND_YIELD` | `:` | Distribution-yield range in %, min:max; missing values do not pass an active range |
| `SEC_YIELD` | `:` | Official 30-day SEC-yield range in %, min:max; missing values do not pass |
| `HOLDINGS_PAGE_SIZE` | `250` | Current holdings rows per JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Daily history rows per JSON page |
| `MAX_RETRIES` | `2` | Retries after the initial request, integer >= 1 (transient HTTP/network failures only) |
| `HISTORY_RANGE` | `max` | Yahoo Finance history window: `max` or `<N>y` (for example `5y`); applied to the request as explicit period1/period2 and replaces the published daily history with that window |
| `PERFORMANCE_YTD` | `:` | YTD performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_1Y` | `:` | 1Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_3Y` | `:` | 3Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_5Y` | `:` | 5Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_10Y` | `:` | 10Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_YTD` | `:` | YTD cumulative total return percent min:max |
| `TOTAL_RETURN_1Y` | `:` | 1Y cumulative total return percent min:max |
| `TOTAL_RETURN_3Y` | `:` | 3Y cumulative total return percent min:max |
| `TOTAL_RETURN_5Y` | `:` | 5Y cumulative total return percent min:max |
| `TOTAL_RETURN_10Y` | `:` | 10Y cumulative total return percent min:max |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC EDGAR User-Agent contact; redacted in logs. The repository Actions variable `SEC_UA` overrides it in the workflow |
| `SKIP_SPFUNDS` | `false` | Skip the official sp-funds.com fund pages (keeps published facts); alias `SKIP_SP_FUNDS` |
| `SKIP_YAHOO` | `false` | Skip Yahoo Finance (keeps published history/dividends) |
| `EDGAR_FALLBACK` | `true` | Use SEC EDGAR N-PORT-P when the issuer's daily holdings file is unavailable |
| `VERBOSE` | `false` | Provider, fallback and retry detail; the compact fund reporter always retains real zero/false values and omits missing fields |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |

`TICKERS` combines with AUM, TER, yield and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Examples

```bash
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="SPUS SPSK SPTE" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
HISTORY_RANGE=5y CONCURRENCY=15 ./scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT — same as all sibling ETF repositories.](./LICENSE)

SP Funds, the fund names and tickers referenced here, and all index names are the property of their respective owners. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by SP Funds or the funds' trusts. All data is reproduced from sp-funds.com's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks are the property of their respective owners.
