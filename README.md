# Sales funnel monitor

Synthetic journeys against the production funnels, with one dashboard for all products.

    npm run serve       # control panel at http://127.0.0.1:4317 (Monitor + Run tests tabs)
    npm run monitor     # run every product's tests, then rebuild the dashboard
    npm run dashboard   # rebuild the dashboard from existing runs

`dashboard/index.html` can also be opened as a file for read-only monitoring; the **Run tests** tab needs `npm run serve`.

## Layout
    tests/<product>/*.spec.ts      one folder per product (travel, ...)
    tests/support/                 shared fixtures (logging, network/console health)
    runs/<run-id>/<env>/<product>/ run.log + <scenario>/{test.log,result.json,screenshots/}   (older runs: <product>/ = production)
    runs/<run-id>/compare/<product>/  report.md, compare.json, *.diff.png   (when both environments ran)
    dashboard/index.html           generated; reads runs/ (keep dashboard/ and runs/ side by side)
    monitor.config.json            titles, environments, product names, ignored HTTP errors, comparison thresholds, masked regions

## Run tests tab
Pick a product, edit or **Randomise dummy data** (random Malaysian citizen aged 18-59, new destinations/dates/plans, flight numbers), then **Start tests**. Progress is live; **Open results in Monitor** jumps to the run. Runs started here are tagged *custom data* and are excluded from availability and trend figures. The server listens on 127.0.0.1 only, validates every field against the product manifest, and runs one test run at a time.

## Adding a product
0. Create `tests/<product>/product.json` (copy `tests/travel/product.json`): product name, `scenarioFields`, `defaultScenarios`, `participantFields` (with `pattern`/`options`/`gen` hints) and `defaultParticipant`. The product then appears in the Run tests tab straight away, before it has any runs.
1. Create the page object and a spec in `tests/<product>/`. Import `test` from `../support/fixtures`, use the `run` fixture (`run.log`, `run.shot`, `run.stoppedAt`), and read per-run data with `loadOverrides()` from `../support/overrides` (see `tests/travel/data.ts`). The server writes `{ scenarios, participant, flight }` to the file named by `RUN_OVERRIDES`.
2. Optionally add a display name under `products` in `monitor.config.json`.
It appears on the dashboard after its first run.

## Status meaning
- Healthy: all steps passed, no first-party HTTP or console errors
- Degraded: passed, but a first-party HTTP/console error occurred (see `ignoredHttp` for known-benign ones)
- Failing: a step failed or timed out

Journeys run through to the **Summary** page and stop there. On Summary they answer the e-invoice (LHDN) question (Yes shows TIN validation, then a valid TIN; No keeps the fields hidden) and tick the declarations, checking that PAY stays disabled until both mandatory ticks are set. **PAY is never clicked**, so Payment Details is never opened. The mandatory Auto Credit step uses a placeholder account number (1234...) sized to the chosen bank's rule, read from the site's own `/api/v1/refs/banks` list. Default bank is RHB; override with the *Auto Credit bank* field or `BANK_NAME`.

Coverage areas: Domestic (Malaysia, 1 plan, +8% SST), Asia, Worldwide excluding USA & Canada, Worldwide including USA & Canada (4 plans each).

## Daily schedule (currently OFF)
The launch agent `com.ikhlas.funnel-monitor` (08:00 daily, `scripts/run-daily.sh`) is unloaded and disabled; its plist is kept at `~/Library/LaunchAgents/`.

    launchctl enable  gui/$(id -u)/com.ikhlas.funnel-monitor
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ikhlas.funnel-monitor.plist   # turn on
    launchctl bootout gui/$(id -u)/com.ikhlas.funnel-monitor                                  # turn off again

## Environments and comparison
`monitor.config.json > environments` defines Production (`https://www.takaful-ikhlas.com.my`) and Sandbox (`https://sandbox.takaful-ikhlas.com.my`).

    TARGET_ENVS=sandbox npx playwright test               # one environment (default: production)
    TARGET_ENVS=production,sandbox npx playwright test    # both, then `npm run dashboard` builds the comparison
    ENV_URL_SANDBOX=https://... npx playwright test       # override a base URL for one run

In the dashboard: the **Monitor** tab has a Production / Sandbox switch, **Run tests** has Production / Sandbox / Both (compare), and **Compare environments** shows the summary report. The control panel checks that each chosen environment is reachable before starting and says so if not (the sandbox may need a VPN).

The comparison covers three things per scenario: **flow** (steps reached, order, page paths, where it ended), **data** (plans offered, prices, totals) and **design** (full-page screenshot diff per step plus headings, labels, buttons and computed styles such as button colour and fonts). Screenshots are full page from the top, animated regions listed in `screenshotMask` are painted over, and thresholds are in `compare`. Comparisons are cached per run; use `node scripts/build-dashboard.mjs --recompare` after changing thresholds. Written reports are saved as `runs/<run-id>/compare/<product>/report.md`.

Noise floor: comparing production with itself gives identical or minor results (rotating content and lazily loaded images can move a few percent of pixels).

## Alerts
`scripts/alert.mjs` runs at the end of `npm run monitor` (so also from the daily job) and compares the latest run with the previous one. Rules and channels are in `alerts.config.json`; secrets go in `.env.local` (copy `.env.example`; it is git-ignored).

| Alert | When |
|---|---|
| FAILING | a scenario fails, once per new failure, then a reminder every `repeatEveryHours` (12) while it stays down |
| RECOVERED | a failing funnel passes again |
| DEGRADED | passed but first-party errors appeared (off by default: `rules.degraded`) |
| ENVIRONMENTS DIFFER | a production-vs-sandbox comparison has different or incomplete scenarios |

Only `rules.environments` (default: production) alert, and runs started from the dashboard with custom data never alert. State is kept in `alerts/state.json`, sent alerts in `alerts/log.jsonl`.

    npm run alert:check     # which enabled channels are ready, and what is missing
    npm run alert:test      # send a test message to every enabled channel
    node scripts/alert.mjs --dry-run   # show what would be sent

**Microsoft Teams:** in the channel, Workflows > "Post to a channel when a webhook request is received", copy the URL into `TEAMS_WEBHOOK_URL`. **Email:** set `channels.email.to` and `from` in `alerts.config.json`, and `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` in `.env.local` (Microsoft 365 uses `smtp.office365.com`, port 587, with SMTP AUTH enabled for the sending mailbox). Slack and a generic webhook are also supported (`SLACK_WEBHOOK_URL`, `ALERT_WEBHOOK_URL`, set `enabled` to true).

Limits: nothing can alert if the machine is off or the run never starts (no new results to look at), so for a true "the monitor stopped" alarm run it from an always-on host.

**Mac alerts (no IT needed):** the `macos` channel is the one in use. It sends a banner and, for critical alerts and tests, also opens a dialog window. macOS only shows the banner if Script Editor is allowed under System Settings > Notifications; without that the banner is dropped silently, which is why the dialog exists. Set `channels.macos.dialog` to `always` or `never` to change this. Teams and email are switched off (`enabled: false`) until IT provides a webhook / SMTP; the email recipient is already set.

## Products
| Product | Folder | Covers |
|---|---|---|
| Travel (IKHLAS Secure Travel) | `tests/travel/` | full quote journey to the Summary page, PAY never clicked |
| Car (IKHLAS Motor Takaful) | `tests/car/` | entry path and the ID + vehicle lookup (see below) |
| Motorcycle (IKHLAS Motorcycle Takaful) | `tests/motorcycle/` | same as car, for the motorcycle funnel; its own saved test record |
| All products (entry points) | `tests/catalogue/` | every product on the site: its button exists and opens, the entry page loads and is the right page (online funnel path, or the enquiry form); no data entered, nothing submitted |

**Car / motor funnels are renewal lookups.** `/direct/motor/` (car, both products) and `/direct/motorcycle/` ask for an ID and a vehicle number and check them against company records; anything not on file returns "001 - Data not found". Synthetic data therefore stops at that step, which is what the car tests verify (page, form rules, lookup service answering). If a synthetic pair ever matches a real record the test fails instead of going on. Going further needs a company-owned test record: enter it in the dashboard (Run tests > Car > **Saved test record**). It is stored only in `.local/secrets.json` (git-ignored, mode 600), the page only ever shows a masked hint, and values are scrubbed from logs, errors and results; traces and failure screenshots are switched off for car tests, and runs that used the record are flagged `sensitive` so their screenshots stay local and are left out of the shared dashboard link. Once saved, the default car run adds a **Saved test record** scenario that walks the funnel page by page to the Summary page (PAY is never pressed, nothing resembling a payment button is ever clicked) and stops with a clear message if a page needs input the test cannot supply. Pages after the lookup were not seen yet, so expect to refine that walk after its first real run. The expected "not found" HTTP 400 and the console errors it triggers are listed under `ignoredHttp` in `monitor.config.json`.

## What each product on the site is
Get Quote buttons open online funnels: car (2 products, one funnel), motorcycle, travel (Secure Travel; the two Kembara products live on `digital.takaful-ikhlas.com.my`), Home Protect (`/direct/home`), Personal Accident (6 plans under `/direct/pa/<plan>`), Direct Hospital Income Benefit (`/direct/hib`) and Basic Term (`/direct/ikhlas-basic-term-hibah-takaful`). "Talk to Us" products (13) open an enquiry form on their product page; the entry-point check confirms the form shows but never submits it (that would create a real sales lead). `tests/catalogue/entries.json` lists them all and drives the check. Deeper journeys exist for travel (to Summary), car and motorcycle (lookup); Home Protect, Personal Accident, Hospital Income Benefit and Basic Term are next.

## Dashboard interaction (added)

- Click a product on **Monitor** to jump to its results; failing product names in the banner and rows on **Insights** do the same.
- **Monitor** has status filters (All / Failing / Warnings / Healthy), a date and result search in Run history, and **Copy status update** for a ready-to-paste summary.
- **Insights** compares journey effort (pages, entries, wait after "next") from the latest run logs and lists notes by priority. The notes are written by hand in `INSIGHT_NOTES` in `scripts/client/app.js`; refresh them when the runs change.
- Every tab has a link you can bookmark: `#monitor-car`, `#insights`, `#compare`, `#run`.
- Actions confirm with a short message at the bottom of the page. **Run tests** keeps its Start button pinned at the bottom.

## Hosting internally

`npm run export` builds a static copy of the dashboard in `dashboard/site/`. `npm run publish:site` rebuilds it and copies it to `SITE_TARGET`.
`hosting/` has an nginx config, a Dockerfile, a compose file and `HOSTING.md` (a checklist for IT: sign-in, HTTPS, network, refresh).

## Marketing tab (genuine traffic)

`npm run marketing` pulls read-only numbers from the **GA4 Data API** and the **Windsor.ai API** into `.local/marketing.json` and rebuilds the dashboard. The Marketing tab also has a **Refresh data** button on the local dashboard. `npm run marketing:sample` fills the tab with made-up numbers to preview the layout.

- Setup: set `ga4.propertyId` in `marketing.config.json`; put `GA4_CREDENTIALS_FILE` (service-account JSON, Viewer on the property) and `WINDSOR_API_KEY` in `.env.local`. Neither is committed.
- The tab is **left out of the shared page and the static export** unless `shareMarketing` is `true` in `marketing.config.json` (it holds traffic and ad spend).
- Checks: data freshness, a sharp drop in sessions or in customers reaching Summary (and whether the synthetic test is failing too), ad spend jumps.
- Events the web team sends to `dataLayer` (GTM forwards them to GA4). No personal data in any parameter.

| Event | Parameters |
|---|---|
| `funnel_start`, `plan_select`, `summary_view`, `pay_click` | `product` |
| `funnel_step`, `funnel_error` | `product`, `step_name` |

`product` must be one of: `car`, `motorcycle`, `travel`, `home`, `personal-accident`, `health`, `hibah`, `savings`. Register `product` and `step_name` as custom dimensions in GA4 (Admin > Custom definitions), or the breakdown stays empty.
