const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

async function q(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

(async () => {
  const conn = await mysql.createConnection({
    host, port, user, password, database: 'amzell', connectTimeout: 15000,
  });

  const cols = await q(conn, `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema='amzell' AND table_name='cron_all_logs' ORDER BY ORDINAL_POSITION`);
  console.log('cron_all_logs cols:', cols.map((c) => c.COLUMN_NAME).join(', '));

  const totalLogs = await q(conn, 'SELECT COUNT(*) AS c FROM cron_all_logs');
  console.log('total logs in amzell:', totalLogs[0].c);

  const recent = await q(conn, 'SELECT ID, iCronID, reportType, iStatus, reportDate, reportStartDateTime, reportEndDateTime FROM cron_all_logs ORDER BY ID DESC LIMIT 5');
  console.log('recent logs:', JSON.stringify(recent, null, 2));

  const logsByCron = await q(conn, `SELECT COUNT(*) c FROM cron_all_logs WHERE iCronID = 370618`);
  console.log('logs for slow cron 370618:', logsByCron[0].c);

  const slowCron = await q(conn, `SELECT * FROM cron_details WHERE ID = 370618`);
  console.log('slow cron header keys with values:', JSON.stringify(slowCron[0], null, 2));

  const failures = await q(conn, `SELECT reportType, LEFT(cronResponse,400) msg, reportStartDateTime FROM cron_failure_logs WHERE iCronID = 370618 LIMIT 20`);
  console.log('failures for 370618:', JSON.stringify(failures, null, 2));

  // Compare Jul 15 vs Jul 14 avg duration across all tenants - sample dashamazon
  await conn.changeUser({ database: 'dashamazon' });
  const compare = await q(conn, `
    SELECT DATE(dtCronStartDate) d,
           COUNT(*) cnt,
           ROUND(AVG(TIMESTAMPDIFF(MINUTE, dtCronStartDate, dtCronEndDate))) avgMin,
           MAX(TIMESTAMPDIFF(MINUTE, dtCronStartDate, dtCronEndDate)) maxMin,
           SUM(iCronRunningStatus=3) retryReady,
           SUM(iCronRunningStatus=1) stillRunning,
           SUM(iCronRunningStatus=2 AND iCronCompleteCopyStatus<>1) copyIncomplete
    FROM cron_details
    WHERE dtCronStartDate >= '2026-07-10'
    GROUP BY DATE(dtCronStartDate)
    ORDER BY d`);
  console.log('dashamazon daily stats:', JSON.stringify(compare, null, 2));

  await conn.end();

  // Cross-tenant aggregate for Jul 14-16
  const master = await mysql.createConnection({ host, port, user, password, database: 'dash_applications' });
  const tenants = await q(master, `SELECT DISTINCT DB_Name dbname FROM user_databases WHERE DB_Name IS NOT NULL AND DB_Name<>''`);
  const schemas = await q(master, `SELECT SCHEMA_NAME n FROM information_schema.schemata`);
  const set = new Set(schemas.map((s) => s.n));
  await master.end();

  const daily = {};
  const statusBreakdown = { jul15: { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, copyIncomplete: 0, retryApi: 0, retryReport: 0 } };
  const entitySlow = {};

  for (const t of tenants.filter((x) => set.has(x.dbname))) {
    let c;
    try {
      c = await mysql.createConnection({ host, port, user, password, database: t.dbname, connectTimeout: 10000 });
    } catch { continue; }
    try {
      const has = await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_details' LIMIT 1`, [t.dbname]);
      if (!has.length) { await c.end(); continue; }

      const rows = await q(c, `
        SELECT DATE(dtCronStartDate) d,
               COUNT(*) cnt,
               ROUND(AVG(TIMESTAMPDIFF(MINUTE, dtCronStartDate, COALESCE(dtCronEndDate, NOW())))) avgMin,
               MAX(TIMESTAMPDIFF(MINUTE, dtCronStartDate, COALESCE(dtCronEndDate, NOW()))) maxMin,
               SUM(iCronRunningStatus=1) s1, SUM(iCronRunningStatus=2) s2, SUM(iCronRunningStatus=3) s3,
               SUM(iCronRunningStatus=4) s4, SUM(iCronRunningStatus=5) s5,
               SUM(iCronRunningStatus=2 AND IFNULL(iCronCompleteCopyStatus,0)<>1) copyInc,
               SUM(IFNULL(iRetryStatus_API_Error,0)=2) retryApi,
               SUM(IFNULL(iRetryStatus_Report_Error,0)=2) retryReport
        FROM cron_details
        WHERE dtCronStartDate >= '2026-07-13' AND dtCronStartDate < '2026-07-17'
        GROUP BY DATE(dtCronStartDate)`);

      for (const r of rows) {
        const key = String(r.d).slice(0, 10);
        if (!daily[key]) daily[key] = { crons: 0, avgMinSum: 0, maxMin: 0, s3: 0, copyInc: 0, retryApi: 0, retryReport: 0, tenants: 0 };
        daily[key].crons += Number(r.cnt);
        daily[key].avgMinSum += Number(r.avgMin || 0) * Number(r.cnt);
        daily[key].maxMin = Math.max(daily[key].maxMin, Number(r.maxMin || 0));
        daily[key].s3 += Number(r.s3);
        daily[key].copyInc += Number(r.copyInc);
        daily[key].retryApi += Number(r.retryApi);
        daily[key].retryReport += Number(r.retryReport);
        daily[key].tenants += 1;
      }

      // Entity status failures on Jul 15
      const ents = await q(c, `
        SELECT 'Campaigns' rt, SUM(CampaignStatus=3) fail, SUM(CampaignStatus=2) partial, MAX(TIMESTAMPDIFF(MINUTE,CampaignStartTime,CampaignEndTime)) maxMin FROM cron_details WHERE DATE(dtCronStartDate)='2026-07-15'
        UNION ALL SELECT 'Keywords', SUM(KeywordsStatus=3), SUM(KeywordsStatus=2), MAX(TIMESTAMPDIFF(MINUTE,KeywordsStartTime,KeywordsEndTime)) FROM cron_details WHERE DATE(dtCronStartDate)='2026-07-15'
        UNION ALL SELECT 'AdGroups', SUM(AdGroupStatus=3), SUM(AdGroupStatus=2), MAX(TIMESTAMPDIFF(MINUTE,AdGroupStartTime,AdGroupEndTime)) FROM cron_details WHERE DATE(dtCronStartDate)='2026-07-15'
        UNION ALL SELECT 'Portfolios', SUM(PortfolioStatus=3), SUM(PortfolioStatus=2), MAX(TIMESTAMPDIFF(MINUTE,PortfolioStartTime,PortfolioEndTime)) FROM cron_details WHERE DATE(dtCronStartDate)='2026-07-15'
        UNION ALL SELECT 'ProductAds', SUM(ProductAdsStatus=3), SUM(ProductAdsStatus=2), MAX(TIMESTAMPDIFF(MINUTE,ProductAdsStartTime,ProductAdsEndTime)) FROM cron_details WHERE DATE(dtCronStartDate)='2026-07-15'
      `);
      for (const e of ents) {
        const k = e.rt;
        if (!entitySlow[k]) entitySlow[k] = { fail: 0, partial: 0, maxMin: 0 };
        entitySlow[k].fail += Number(e.fail || 0);
        entitySlow[k].partial += Number(e.partial || 0);
        entitySlow[k].maxMin = Math.max(entitySlow[k].maxMin, Number(e.maxMin || 0));
      }

      // failure logs jul 15 by date column variants
    } catch (e) {
      // ignore
    } finally {
      await c.end();
    }
  }

  let globalFailCount = 0;
  // recount failures properly
  for (const t of tenants.filter((x) => set.has(x.dbname))) {
    let c;
    try { c = await mysql.createConnection({ host, port, user, password, database: t.dbname, connectTimeout: 8000 }); } catch { continue; }
    try {
      const has = await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_failure_logs' LIMIT 1`, [t.dbname]);
      if (!has.length) continue;
      const fl = await q(c, `SELECT COUNT(*) c FROM cron_failure_logs WHERE reportStartDateTime >= '2026-07-15' AND reportStartDateTime < '2026-07-16'`);
      globalFailCount += Number(fl[0].c);
    } catch {} finally { await c.end(); }
  }

  const dailyOut = Object.entries(daily).map(([d, v]) => ({
    date: d,
    crons: v.crons,
    avgMin: v.crons ? Math.round(v.avgMinSum / v.crons) : 0,
    maxMin: v.maxMin,
    retryReady: v.s3,
    copyIncomplete: v.copyInc,
    retryApiFlag: v.retryApi,
    retryReportFlag: v.retryReport,
    activeTenants: v.tenants,
  })).sort((a, b) => a.date.localeCompare(b.date));

  console.log('\n=== CROSS-TENANT DAILY ===');
  console.log(JSON.stringify(dailyOut, null, 2));
  console.log('\n=== ENTITY FAILURES JUL 15 ===');
  console.log(JSON.stringify(entitySlow, null, 2));
  console.log('\n=== FAILURE LOGS JUL 15 (reportStartDateTime) ===', globalFailCount);
})();
