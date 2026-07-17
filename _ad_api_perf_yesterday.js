const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const MASTER = 'dash_applications';
const TARGET_DATE = '2026-07-15';
const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

async function q(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function tableExists(conn, db, table) {
  const rows = await q(
    conn,
    `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema=? AND table_name=? LIMIT 1`,
    [db, table]
  );
  return rows.length > 0;
}

async function analyzeTenant(dbname) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database: dbname,
      connectTimeout: 15000,
    });
  } catch (e) {
    return { dbname, reachable: false, error: String(e.message || e).slice(0, 200) };
  }

  const out = {
    dbname,
    reachable: true,
    cronsOnDate: [],
    slowCrons: [],
    stuckCrons: [],
    incompleteCopy: [],
    logStats: { total: 0, success: 0, failure: 0, slowReports: [] },
    failureMessages: [],
    reportTypeFailures: [],
    reportTypeDurations: [],
  };

  try {
    const hasCron = await tableExists(conn, dbname, 'cron_details');
    const hasLogs = await tableExists(conn, dbname, 'cron_all_logs');
    const hasFailures = await tableExists(conn, dbname, 'cron_failure_logs');
    if (!hasCron) {
      out.skip = 'no cron_details';
      await conn.end();
      return out;
    }

    // Crons that started on target date
    out.cronsOnDate = await q(
      conn,
      `SELECT ID, SellerID, SellerName, ProfileId,
              iCronRunningStatus, iCronCompleteCopyStatus,
              iRetryStatus_API_Error, iRetryStatus_Report_Error,
              dtCronStartDate, dtCronEndDate,
              TIMESTAMPDIFF(MINUTE, dtCronStartDate, COALESCE(dtCronEndDate, NOW())) AS durationMin
       FROM cron_details
       WHERE DATE(dtCronStartDate) = ?
       ORDER BY durationMin DESC
       LIMIT 50`,
      [TARGET_DATE]
    );

    out.slowCrons = out.cronsOnDate.filter((c) => Number(c.durationMin) >= 120);
    out.stuckCrons = out.cronsOnDate.filter(
      (c) => Number(c.iCronRunningStatus) === 1 && !c.dtCronEndDate
    );
    out.incompleteCopy = out.cronsOnDate.filter(
      (c) => Number(c.iCronRunningStatus) === 2 && Number(c.iCronCompleteCopyStatus) !== 1
    );

    if (hasLogs) {
      const logAgg = await q(
        conn,
        `SELECT
           COUNT(*) AS total,
           SUM(iStatus = 1) AS success,
           SUM(iStatus = 2) AS failure
         FROM cron_all_logs
         WHERE DATE(COALESCE(reportStartDateTime, dtCreatedOn)) = ?`,
        [TARGET_DATE]
      );
      if (logAgg[0]) {
        out.logStats.total = Number(logAgg[0].total || 0);
        out.logStats.success = Number(logAgg[0].success || 0);
        out.logStats.failure = Number(logAgg[0].failure || 0);
      }

      out.reportTypeDurations = await q(
        conn,
        `SELECT reportType,
                COUNT(*) AS cnt,
                SUM(iStatus = 2) AS failures,
                ROUND(AVG(TIMESTAMPDIFF(SECOND, reportStartDateTime, reportEndDateTime))) AS avgSec,
                MAX(TIMESTAMPDIFF(SECOND, reportStartDateTime, reportEndDateTime)) AS maxSec
         FROM cron_all_logs
         WHERE DATE(COALESCE(reportStartDateTime, dtCreatedOn)) = ?
           AND reportStartDateTime IS NOT NULL AND reportEndDateTime IS NOT NULL
         GROUP BY reportType
         HAVING cnt >= 3
         ORDER BY avgSec DESC
         LIMIT 15`,
        [TARGET_DATE]
      );

      out.logStats.slowReports = await q(
        conn,
        `SELECT ID, iCronID, reportType, iStatus,
                reportStartDateTime, reportEndDateTime,
                TIMESTAMPDIFF(MINUTE, reportStartDateTime, reportEndDateTime) AS durationMin,
                recordCount
         FROM cron_all_logs
         WHERE DATE(COALESCE(reportStartDateTime, dtCreatedOn)) = ?
           AND reportStartDateTime IS NOT NULL AND reportEndDateTime IS NOT NULL
           AND TIMESTAMPDIFF(MINUTE, reportStartDateTime, reportEndDateTime) >= 30
         ORDER BY durationMin DESC
         LIMIT 20`,
        [TARGET_DATE]
      );
    }

    if (hasFailures) {
      out.reportTypeFailures = await q(
        conn,
        `SELECT reportType, COUNT(*) AS cnt
         FROM cron_failure_logs
         WHERE DATE(COALESCE(reportStartDateTime, dtCreatedOn)) = ?
         GROUP BY reportType
         ORDER BY cnt DESC
         LIMIT 15`,
        [TARGET_DATE]
      );

      out.failureMessages = await q(
        conn,
        `SELECT reportType,
                LEFT(cronResponse, 300) AS msgSample,
                COUNT(*) AS cnt
         FROM cron_failure_logs
         WHERE DATE(COALESCE(reportStartDateTime, dtCreatedOn)) = ?
           AND cronResponse IS NOT NULL AND cronResponse <> ''
         GROUP BY reportType, LEFT(cronResponse, 300)
         ORDER BY cnt DESC
         LIMIT 20`,
        [TARGET_DATE]
      );
    }
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  } finally {
    await conn.end();
  }

  out.hasActivity =
    out.cronsOnDate.length > 0 ||
    out.logStats.total > 0 ||
    out.failureMessages.length > 0;

  return out;
}

(async () => {
  const master = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database: MASTER,
    connectTimeout: 20000,
  });

  const listed = await q(
    master,
    `SELECT DISTINCT DB_Name AS dbname FROM user_databases
     WHERE DB_Name IS NOT NULL AND DB_Name <> '' ORDER BY DB_Name`
  );
  const schemas = await q(master, `SELECT SCHEMA_NAME AS n FROM information_schema.schemata`);
  const schemaSet = new Set(schemas.map((s) => s.n));
  await master.end();

  const onHost = listed.filter((t) => schemaSet.has(t.dbname));
  const results = [];

  for (let i = 0; i < onHost.length; i++) {
    const t = onHost[i];
    process.stderr.write(`[${i + 1}/${onHost.length}] ${t.dbname} ... `);
    const r = await analyzeTenant(t.dbname);
    process.stderr.write(r.hasActivity ? 'activity\n' : (r.skip || 'ok') + '\n');
    if (r.hasActivity) results.push(r);
  }

  const summary = {
    targetDate: TARGET_DATE,
    tenantsScanned: onHost.length,
    tenantsWithActivity: results.length,
    totalCrons: results.reduce((s, r) => s + r.cronsOnDate.length, 0),
    slowCrons2hPlus: results.reduce((s, r) => s + r.slowCrons.length, 0),
    stuckCrons: results.reduce((s, r) => s + r.stuckCrons.length, 0),
    incompleteCopy: results.reduce((s, r) => s + r.incompleteCopy.length, 0),
    logTotal: results.reduce((s, r) => s + r.logStats.total, 0),
    logFailures: results.reduce((s, r) => s + r.logStats.failure, 0),
    logSuccess: results.reduce((s, r) => s + r.logStats.success, 0),
  };

  // Aggregate slow report types across tenants
  const reportDurMap = {};
  const reportFailMap = {};
  const errorMap = {};

  for (const r of results) {
    for (const row of r.reportTypeDurations || []) {
      const k = row.reportType;
      if (!reportDurMap[k]) reportDurMap[k] = { cnt: 0, failures: 0, avgSecSum: 0, maxSec: 0, tenants: new Set() };
      reportDurMap[k].cnt += Number(row.cnt);
      reportDurMap[k].failures += Number(row.failures || 0);
      reportDurMap[k].avgSecSum += Number(row.avgSec || 0) * Number(row.cnt);
      reportDurMap[k].maxSec = Math.max(reportDurMap[k].maxSec, Number(row.maxSec || 0));
      reportDurMap[k].tenants.add(r.dbname);
    }
    for (const row of r.reportTypeFailures || []) {
      reportFailMap[row.reportType] = (reportFailMap[row.reportType] || 0) + Number(row.cnt);
    }
    for (const row of r.failureMessages || []) {
      const key = (row.msgSample || '').slice(0, 120);
      if (!errorMap[key]) errorMap[key] = { cnt: 0, reportTypes: new Set() };
      errorMap[key].cnt += Number(row.cnt);
      errorMap[key].reportTypes.add(row.reportType);
    }
  }

  const topSlowReports = Object.entries(reportDurMap)
    .map(([reportType, v]) => ({
      reportType,
      cnt: v.cnt,
      failures: v.failures,
      avgSec: v.cnt ? Math.round(v.avgSecSum / v.cnt) : 0,
      maxSec: v.maxSec,
      tenantCount: v.tenants.size,
    }))
    .sort((a, b) => b.avgSec - a.avgSec)
    .slice(0, 15);

  const topFailures = Object.entries(reportFailMap)
    .map(([reportType, cnt]) => ({ reportType, cnt }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 15);

  const topErrors = Object.entries(errorMap)
    .map(([msg, v]) => ({ msg, cnt: v.cnt, reportTypes: [...v.reportTypes].slice(0, 5) }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 15);

  const worstTenants = results
    .map((r) => ({
      dbname: r.dbname,
      crons: r.cronsOnDate.length,
      slowCrons: r.slowCrons.length,
      maxCronMin: r.cronsOnDate.length ? Math.max(...r.cronsOnDate.map((c) => Number(c.durationMin || 0))) : 0,
      logFailures: r.logStats.failure,
      logTotal: r.logStats.total,
      stuck: r.stuckCrons.length,
      incompleteCopy: r.incompleteCopy.length,
    }))
    .sort((a, b) => b.maxCronMin - a.maxCronMin || b.logFailures - a.logFailures)
    .slice(0, 15);

  const worstSlowCrons = results
    .flatMap((r) =>
      r.slowCrons.map((c) => ({
        dbname: r.dbname,
        cronId: c.ID,
        seller: c.SellerName || c.SellerID,
        status: c.iCronRunningStatus,
        copyStatus: c.iCronCompleteCopyStatus,
        start: c.dtCronStartDate,
        end: c.dtCronEndDate,
        durationMin: c.durationMin,
        retryApi: c.iRetryStatus_API_Error,
        retryReport: c.iRetryStatus_Report_Error,
      }))
    )
    .sort((a, b) => b.durationMin - a.durationMin)
    .slice(0, 20);

  console.log(
    JSON.stringify(
      { summary, topSlowReports, topFailures, topErrors, worstTenants, worstSlowCrons },
      null,
      2
    )
  );
})();
