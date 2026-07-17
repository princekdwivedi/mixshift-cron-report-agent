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

function classify(msg) {
  if (!msg) return 'empty';
  if (/429 Too Many Requests/i.test(msg)) return '429_rate_limit';
  if (/401 Unauthorized/i.test(msg)) return '401_unauthorized';
  if (/403 Forbidden/i.test(msg)) return '403_forbidden';
  if (/503 Service Unavailable/i.test(msg)) return '503_unavailable';
  if (/500 Internal Server Error/i.test(msg)) return '500_server_error';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/empty report|no data/i.test(msg)) return 'empty_report';
  return 'other';
}

(async () => {
  const master = await mysql.createConnection({ host, port, user, password, database: 'dash_applications' });
  const tenants = await q(master, `SELECT DISTINCT DB_Name dbname FROM user_databases WHERE DB_Name IS NOT NULL AND DB_Name<>''`);
  const schemas = await q(master, `SELECT SCHEMA_NAME n FROM information_schema.schemata`);
  const set = new Set(schemas.map((s) => s.n));
  await master.end();

  const errorTypes = {};
  const reportFails = {};
  const stuckLogs = { total: 0, byType: {} };
  const logStats = { total: 0, success: 0, failure: 0, incomplete: 0 };
  const retryCrons = { jul14: 0, jul15: 0, jul16: 0 };

  for (const t of tenants.filter((x) => set.has(x.dbname))) {
    let c;
    try { c = await mysql.createConnection({ host, port, user, password, database: t.dbname, connectTimeout: 8000 }); } catch { continue; }
    try {
      const hasFail = await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_failure_logs' LIMIT 1`, [t.dbname]);
      if (hasFail.length) {
        const fails = await q(c, `
          SELECT reportType, cronResponse
          FROM cron_failure_logs
          WHERE reportStartDateTime >= '2026-07-15' AND reportStartDateTime < '2026-07-16'
          LIMIT 5000`);
        for (const f of fails) {
          const cls = classify(f.cronResponse);
          errorTypes[cls] = (errorTypes[cls] || 0) + 1;
          const rk = f.reportType || 'unknown';
          reportFails[rk] = (reportFails[rk] || 0) + 1;
        }
      }

      const hasLogs = await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_all_logs' LIMIT 1`, [t.dbname]);
      if (hasLogs.length) {
        const stats = await q(c, `
          SELECT COUNT(*) total,
                 SUM(iStatus=1) ok,
                 SUM(iStatus=2) fail,
                 SUM(reportEndDateTime IS NULL AND reportStartDateTime IS NOT NULL) incomplete
          FROM cron_all_logs
          WHERE reportStartDateTime >= '2026-07-15' AND reportStartDateTime < '2026-07-16'`);
        logStats.total += Number(stats[0].total || 0);
        logStats.success += Number(stats[0].ok || 0);
        logStats.failure += Number(stats[0].fail || 0);
        logStats.incomplete += Number(stats[0].incomplete || 0);

        const stuck = await q(c, `
          SELECT reportType, COUNT(*) c
          FROM cron_all_logs
          WHERE reportStartDateTime >= '2026-07-15' AND reportStartDateTime < '2026-07-16'
            AND reportEndDateTime IS NULL AND reportStartDateTime IS NOT NULL
          GROUP BY reportType ORDER BY c DESC LIMIT 10`);
        for (const s of stuck) {
          stuckLogs.total += Number(s.c);
          stuckLogs.byType[s.reportType] = (stuckLogs.byType[s.reportType] || 0) + Number(s.c);
        }
      }

      const hasCron = await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_details' LIMIT 1`, [t.dbname]);
      if (hasCron.length) {
        for (const [label, start, end] of [
          ['jul14', '2026-07-14', '2026-07-15'],
          ['jul15', '2026-07-15', '2026-07-16'],
          ['jul16', '2026-07-16', '2026-07-17'],
        ]) {
          const r = await q(c, `SELECT COUNT(*) c FROM cron_details WHERE dtCronStartDate >= ? AND dtCronStartDate < ? AND iCronRunningStatus=3`, [start, end]);
          retryCrons[label] += Number(r[0].c);
        }
      }
    } catch {} finally { await c.end(); }
  }

  const topReports = Object.entries(reportFails).sort((a,b)=>b[1]-a[1]).slice(0,15);
  const topStuck = Object.entries(stuckLogs.byType).sort((a,b)=>b[1]-a[1]).slice(0,15);

  console.log(JSON.stringify({
    jul15FailureLogCount_sampled: Object.values(errorTypes).reduce((a,b)=>a+b,0),
    errorBreakdown: Object.entries(errorTypes).sort((a,b)=>b[1]-a[1]),
    topFailingReportTypes: topReports,
    jul15AllLogs: logStats,
    incompleteLogsByType: topStuck,
    cronsReadyForRetry: retryCrons,
  }, null, 2));
})();
