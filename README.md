# Cron Report Agent

CLI agent that connects directly to a **tenant MySQL database** and returns a success/failure summary for cron jobs across:

| Service | Tables |
|---------|--------|
| **SP API** | `mws_cron_details`, `mws_cron_all_logs`, `mws_cron_failure_logs` (+ vendor/custom) |
| **Ad API** | `cron_details`, `cron_all_logs`, `cron_failure_logs` (+ DSP) |
| **Backend** | `keyword_cron_*` + AD copy status (`iCronCompleteCopyStatus`) |
| **SQP** | `sqp_cron_details`, `sqp_cron_logs`, `sqp_download_urls` |

## Setup

```bash
cd cron-report-agent
npm install
cp .env.example .env
# edit DB_HOST / DB_USER / DB_PASSWORD
```

## Usage

Pass **dbname**, **sellerId**, and **cronJob** name:

```bash
node src/cli.js --dbname=YOUR_TENANT_DB --sellerId=12345 --cronJob=sp-api
node src/cli.js --dbname=YOUR_TENANT_DB --sellerId=A1XXXXXX --cronJob=Campaigns
node src/cli.js --dbname=YOUR_TENANT_DB --sellerId=12345 --cronJob=WEEK --service=sqp
node src/cli.js --dbname=YOUR_TENANT_DB --sellerId=12345 --cronJob=all
node src/cli.js --list-jobs
```

### Inputs

| Flag | Description |
|------|-------------|
| `--dbname` | Tenant DB name (from `user_databases.DB_Name`) |
| `--sellerId` | `seller.ID` **or** `AmazonSellerID` |
| `--cronJob` | Report type (`Campaigns`, `GetMatchingProduct`, `WEEK`, …) **or** alias (`sp-api`, `ad-api`, `backend`, `sqp`, `all`) |
| `--service` | Optional force: `sp` \| `ad` \| `backend` \| `sqp` \| `all` |

### Output

JSON with:

- `summary.verdict` → `OK` | `HAS_FAILURES` | `NO_DATA` | `NO_LOG_ROWS`
- `summary.totals` → success / failure counts
- `services[].sections[]` → latest cron header, logs, failures, error messages

Exit codes: `0` OK, `2` has failures, `1` error.

## Web UI

```bash
npm run ui
# open http://localhost:3847
```

Enter **dbname**, **seller ID**, and **cron job**, then click **Run report**.  
The page shows verdict, success/failure counts, per-service sections, failures, and logs. Use **Toggle raw JSON** for the full payload.

Optional: set `PORT` in `.env` (default `3847`).


```js
const { getCronReport } = require('./src');

const report = await getCronReport({
  dbname: 'agency_db',
  sellerId: '12345',
  cronJobName: 'ad-api',
});
```
