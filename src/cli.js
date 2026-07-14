#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from package root if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const { getCronReport, listAllJobs } = require('./index');

function printHelp() {
  console.log(`
Cron Report Agent
=================
Query tenant MySQL for Ad API / SP API / Backend / SQP cron success & failure summaries.

Usage:
  node src/cli.js --dbname=<tenant_db> --sellerId=<id|amazonSellerId> --cronJob=<name> [options]

Required:
  --dbname        Tenant database name
  --sellerId      Internal seller.ID or AmazonSellerID
  --cronJob       Job/report type OR alias: sp-api | ad-api | backend | sqp | all
                  Examples: Campaigns, GetMatchingProduct, WEEK, keywordHarvesting

Options:
  --service       Force service: sp | ad | backend | sqp | all
  --list-jobs     Print known cron job names and exit
  --pretty        Pretty-print JSON (default)
  --compact       Single-line JSON
  --help

Env (.env):
  DB_HOST  DB_PORT  DB_USER  DB_PASSWORD

Examples:
  node src/cli.js --dbname=agency_acme --sellerId=12345 --cronJob=sp-api
  node src/cli.js --dbname=agency_acme --sellerId=A1XXXX --cronJob=Campaigns
  node src/cli.js --dbname=agency_acme --sellerId=12345 --cronJob=WEEK --service=sqp
  node src/cli.js --dbname=agency_acme --sellerId=12345 --cronJob=all
`);
}

function parseArgs(argv) {
  const out = { pretty: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list-jobs') out.listJobs = true;
    else if (a === '--pretty') out.pretty = true;
    else if (a === '--compact') out.pretty = false;
    else if (a.startsWith('--dbname=')) out.dbname = a.slice(9);
    else if (a.startsWith('--sellerId=')) out.sellerId = a.slice(11);
    else if (a.startsWith('--cronJob=')) out.cronJobName = a.slice(10);
    else if (a.startsWith('--cronjob=')) out.cronJobName = a.slice(10);
    else if (a.startsWith('--service=')) out.service = a.slice(10);
    else if (a === '--dbname') out.dbname = argv[++i];
    else if (a === '--sellerId') out.sellerId = argv[++i];
    else if (a === '--cronJob' || a === '--cronjob') out.cronJobName = argv[++i];
    else if (a === '--service') out.service = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      out.help = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.listJobs) {
    console.log(JSON.stringify(listAllJobs(), null, 2));
    process.exit(0);
  }

  if (!args.dbname || !args.sellerId || !args.cronJobName) {
    printHelp();
    console.error('Error: --dbname, --sellerId, and --cronJob are required.');
    process.exit(1);
  }

  try {
    const report = await getCronReport({
      dbname: args.dbname,
      sellerId: args.sellerId,
      cronJobName: args.cronJobName,
      service: args.service,
    });
    console.log(args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report));
    process.exit(report.summary?.verdict === 'HAS_FAILURES' ? 2 : 0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

main();
