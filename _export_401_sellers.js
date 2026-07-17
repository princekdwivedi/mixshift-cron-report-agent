const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const h = process.env.DB_HOST, p = process.env.DB_PORT, u = process.env.DB_USER, pw = process.env.DB_PASSWORD;
const START = '2026-07-16';
const END = '2026-07-17';

async function q(c, sql, pa = []) {
  const [r] = await c.query(sql, pa);
  return r;
}

(async () => {
  const m = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: 'dash_applications' });
  const tenants = (await q(m, `SELECT DISTINCT DB_Name dbname FROM user_databases WHERE DB_Name IS NOT NULL AND DB_Name<>'' ORDER BY DB_Name`)).map((x) => x.dbname);
  const schemas = new Set((await q(m, `SELECT SCHEMA_NAME n FROM information_schema.schemata`)).map((x) => x.n));
  await m.end();

  const rows = [];

  for (const db of tenants.filter((d) => schemas.has(d))) {
    let c;
    try {
      c = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: db, connectTimeout: 8000 });
    } catch {
      continue;
    }

    try {
      const hasFail = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_failure_logs' LIMIT 1`, [db])).length;
      const hasSeller = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='seller' LIMIT 1`, [db])).length;
      if (!hasFail || !hasSeller) continue;

      const sellerCols = await q(c, `SELECT COLUMN_NAME n FROM information_schema.columns WHERE table_schema=? AND table_name='seller'`, [db]);
      const sc = new Set(sellerCols.map((x) => x.n));

      const selectParts = ['s.ID AS sellerId'];
      if (sc.has('AmazonSellerID')) selectParts.push('s.AmazonSellerID');
      if (sc.has('Name')) selectParts.push('s.Name AS sellerName');
      else if (sc.has('MerchantAlias')) selectParts.push('s.MerchantAlias AS sellerName');
      if (sc.has('ProfileId')) selectParts.push('s.ProfileId');
      if (sc.has('isAdLostAccess')) selectParts.push('IFNULL(s.isAdLostAccess,0) AS isAdLostAccess');
      else selectParts.push('NULL AS isAdLostAccess');
      if (sc.has('idUserAccount')) selectParts.push('s.idUserAccount');
      if (sc.has('MarketPlaceID')) selectParts.push('s.MarketPlaceID');

      const data = await q(c, `
        SELECT ${selectParts.join(', ')},
               COUNT(DISTINCT f.ID) AS fail401Count,
               COUNT(DISTINCT f.reportType) AS affectedReportTypes,
               MIN(f.reportStartDateTime) AS first401At,
               MAX(f.reportStartDateTime) AS last401At,
               MAX(c.iCronRunningStatus) AS cronStatus,
               MAX(c.dtCronEndDate) AS cronEndDate
        FROM cron_failure_logs f
        JOIN seller s ON (s.ID = f.SellerID OR s.AmazonSellerID = f.SellerID)
        LEFT JOIN cron_details c ON c.ID = f.iCronID
        WHERE f.reportStartDateTime >= ? AND f.reportStartDateTime < ?
          AND f.cronResponse LIKE '%401 Unauthorized%'
        GROUP BY ${selectParts.map((p) => p.split(' AS ')[0]).join(', ')}
        ORDER BY fail401Count DESC`, [START, END]);

      for (const r of data) {
        rows.push({
          dbname: db,
          sellerId: r.sellerId,
          amazonSellerId: r.AmazonSellerID ?? null,
          sellerName: r.sellerName ?? null,
          profileId: r.ProfileId ?? null,
          marketPlaceId: r.MarketPlaceID ?? null,
          idUserAccount: r.idUserAccount ?? null,
          isAdLostAccess: r.isAdLostAccess,
          lostAccessLabel: Number(r.isAdLostAccess) === 1 ? 'Yes' : Number(r.isAdLostAccess) === 0 ? 'No' : 'Unknown',
          fail401Count: Number(r.fail401Count),
          affectedReportTypes: Number(r.affectedReportTypes),
          first401At: r.first401At,
          last401At: r.last401At,
          cronStatus: r.cronStatus,
          cronEndDate: r.cronEndDate,
        });
      }
    } catch (e) {
      // skip tenant on error
    } finally {
      await c.end();
    }
  }

  rows.sort((a, b) => b.fail401Count - a.fail401Count || a.dbname.localeCompare(b.dbname));

  const summary = {
    date: START,
    totalSellers: rows.length,
    total401Logs: rows.reduce((s, r) => s + r.fail401Count, 0),
    markedLostAccess: rows.filter((r) => Number(r.isAdLostAccess) === 1).length,
    notMarkedLostAccess: rows.filter((r) => Number(r.isAdLostAccess) === 0).length,
    tenantsAffected: [...new Set(rows.map((r) => r.dbname))].length,
    byTenant: {},
  };

  for (const r of rows) {
    if (!summary.byTenant[r.dbname]) summary.byTenant[r.dbname] = { sellers: 0, fail401Logs: 0, notLostAccess: 0 };
    summary.byTenant[r.dbname].sellers++;
    summary.byTenant[r.dbname].fail401Logs += r.fail401Count;
    if (Number(r.isAdLostAccess) === 0) summary.byTenant[r.dbname].notLostAccess++;
  }

  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, '_401_sellers_jul16.json'), JSON.stringify({ summary, sellers: rows }, null, 2));

  // CSV for easy client share
  const headers = ['dbname', 'sellerId', 'amazonSellerId', 'sellerName', 'profileId', 'marketPlaceId', 'idUserAccount', 'lostAccessLabel', 'fail401Count', 'affectedReportTypes', 'first401At', 'last401At', 'cronStatus', 'cronEndDate'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map((h) => {
      const v = r[h];
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(','));
  }
  fs.writeFileSync(path.join(__dirname, '_401_sellers_jul16.csv'), csv.join('\n'));

  console.log(JSON.stringify(summary, null, 2));
  console.log('\nWrote _401_sellers_jul16.json and _401_sellers_jul16.csv');
})();
