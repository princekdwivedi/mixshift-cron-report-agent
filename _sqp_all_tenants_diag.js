const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const MASTER = 'dash_applications';
const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

async function q(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}
async function tableExists(conn, db, table) {
  const rows = await q(conn,
    `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema=? AND table_name=? LIMIT 1`,
    [db, table]);
  return rows.length > 0;
}
async function columnExists(conn, db, table, col) {
  const rows = await q(conn,
    `SELECT 1 AS ok FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=? LIMIT 1`,
    [db, table, col]);
  return rows.length > 0;
}
function sum(arr, fn) {
  let s = 0;
  for (const x of arr) {
    const v = fn(x);
    if (v != null && !Number.isNaN(Number(v))) s += Number(v);
  }
  return s;
}

async function diagnoseTenant(dbname) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user, password, database: dbname, connectTimeout: 15000,
    });
  } catch (e) {
    return { dbname, reachable: false, error: String(e.message || e).slice(0, 200), diagnosis: 'unreachable', missingTables: [], A: {}, B: {}, C: {}, flags: {} };
  }

  const out = { dbname, reachable: true, error: null, missingTables: [], A: {}, B: {}, C: {}, flags: {}, diagnosis: 'unknown' };

  try {
    const hasSeller = await tableExists(conn, dbname, 'seller');
    const hasAsin = await tableExists(conn, dbname, 'seller_ASIN_list');
    const hasOauth = await tableExists(conn, dbname, 'tbl_mws_oauth_token')
      || await tableExists(conn, dbname, 'mws_oauth_token');
    const oauthTable = (await tableExists(conn, dbname, 'tbl_mws_oauth_token'))
      ? 'tbl_mws_oauth_token'
      : ((await tableExists(conn, dbname, 'mws_oauth_token')) ? 'mws_oauth_token' : null);
    const hasCron = await tableExists(conn, dbname, 'sqp_cron_details');
    const hasLogs = await tableExists(conn, dbname, 'sqp_cron_logs');
    const hasUrls = await tableExists(conn, dbname, 'sqp_download_urls');

    for (const [flag, name] of [
      [hasSeller, 'seller'], [hasAsin, 'seller_ASIN_list'],
      [hasOauth, 'tbl_mws_oauth_token/mws_oauth_token'],
      [hasCron, 'sqp_cron_details'], [hasLogs, 'sqp_cron_logs'], [hasUrls, 'sqp_download_urls'],
    ]) {
      if (!flag) out.missingTables.push(name);
    }

    // A
    if (hasSeller) {
      out.A.mwsSellers = Number((await q(conn, `SELECT COUNT(*) AS c FROM seller WHERE isMwsUser=1`))[0].c);

      if (await columnExists(conn, dbname, 'seller', 'dtLatestSQPPullDate')) {
        const r = await q(conn, `
          SELECT SUM(dtLatestSQPPullDate IS NOT NULL) AS withPull,
                 SUM(dtLatestSQPPullDate IS NULL) AS withoutPull
          FROM seller WHERE isMwsUser=1`);
        out.A.dtLatestSQP_notNull = Number(r[0].withPull || 0);
        out.A.dtLatestSQP_null = Number(r[0].withoutPull || 0);
      }

      if (await columnExists(conn, dbname, 'seller', 'isBrandAnalyticsLostAccess')) {
        const ba = await q(conn, `
          SELECT SUM(IFNULL(isBrandAnalyticsLostAccess,0)=1) AS lost
          FROM seller WHERE isMwsUser=1`);
        out.A.brandAnalyticsLost = Number(ba[0].lost || 0);
      }

      if (oauthTable) {
        // Join via AmazonSellerID (SQP auth path)
        const lost = await q(conn, `
          SELECT
            SUM(CASE WHEN t.id IS NULL OR t.iLostAccess=1 THEN 1 ELSE 0 END) AS lostOrNoToken,
            SUM(CASE WHEN t.id IS NOT NULL AND IFNULL(t.iLostAccess,0)=0 THEN 1 ELSE 0 END) AS okToken
          FROM seller s
          LEFT JOIN \`${oauthTable}\` t ON t.AmazonSellerID = s.AmazonSellerID
          WHERE s.isMwsUser=1`);
        out.A.lostAccessOrNoToken = Number(lost[0].lostOrNoToken || 0);
        out.A.okToken = Number(lost[0].okToken || 0);
        out.A.oauthTable = oauthTable;
      } else {
        out.A.lostAccessOrNoToken = null;
        out.A.okToken = null;
      }
    }

    if (hasAsin) {
      out.A.asinTotal = Number((await q(conn, `SELECT COUNT(*) AS c FROM seller_ASIN_list`))[0].c);
      out.A.asinActive = Number((await q(conn, `SELECT COUNT(*) AS c FROM seller_ASIN_list WHERE IsActive=1`))[0].c);
      if (await columnExists(conn, dbname, 'seller_ASIN_list', 'InitialPullStatus')) {
        const br = await q(conn, `
          SELECT SUM(InitialPullStatus IS NULL) AS st_null,
                 SUM(InitialPullStatus=0) AS st_0, SUM(InitialPullStatus=1) AS st_1,
                 SUM(InitialPullStatus=2) AS st_2, SUM(InitialPullStatus=3) AS st_3
          FROM seller_ASIN_list WHERE IsActive=1`);
        out.A.asinInit = {
          null: Number(br[0].st_null || 0),
          pending0: Number(br[0].st_0 || 0),
          inProgress1: Number(br[0].st_1 || 0),
          completed2: Number(br[0].st_2 || 0),
          failed3: Number(br[0].st_3 || 0),
        };
        out.A.asinNeedInitial = Number((await q(conn, `
          SELECT COUNT(*) AS c FROM seller_ASIN_list
          WHERE IsActive=1 AND (InitialPullStatus IS NULL OR InitialPullStatus <> 2)`))[0].c);
      }
    }

    // B
    if (hasCron) {
      const sellerCol = (await columnExists(conn, dbname, 'sqp_cron_details', 'SellerID'))
        ? 'SellerID'
        : ((await columnExists(conn, dbname, 'sqp_cron_details', 'fkSellerID')) ? 'fkSellerID' : null);

      const counts = await q(conn, `
        SELECT SUM(iInitialPull=1) AS initialJobs, SUM(iInitialPull=0) AS regularJobs, COUNT(*) AS totalJobs
        FROM sqp_cron_details`);
      out.B.initialJobs = Number(counts[0].initialJobs || 0);
      out.B.regularJobs = Number(counts[0].regularJobs || 0);
      out.B.totalJobs = Number(counts[0].totalJobs || 0);

      const statusBr = await q(conn, `
        SELECT iInitialPull,
          SUM(cronRunningStatus IN (1,4)) AS running,
          SUM(cronRunningStatus IN (2,5)) AS completed,
          SUM(cronRunningStatus=3) AS retry,
          SUM(cronRunningStatus NOT IN (1,2,3,4,5) OR cronRunningStatus IS NULL) AS other,
          COUNT(*) AS total
        FROM sqp_cron_details GROUP BY iInitialPull`);
      out.B.statusByType = {};
      for (const r of statusBr) {
        const key = Number(r.iInitialPull) === 1 ? 'initial' : 'regular';
        out.B.statusByType[key] = {
          running: Number(r.running || 0),
          completed: Number(r.completed || 0),
          retry: Number(r.retry || 0),
          other: Number(r.other || 0),
          total: Number(r.total || 0),
        };
      }

      const hasUpdated = await columnExists(conn, dbname, 'sqp_cron_details', 'dtUpdatedOn');
      const latestCols = `ID, iInitialPull, cronRunningStatus, ${sellerCol || 'NULL AS SellerID'},
        WeeklySQPDataPullStatus, MonthlySQPDataPullStatus, QuarterlySQPDataPullStatus` +
        (hasUpdated ? ', dtUpdatedOn' : '');
      const latest = await q(conn,
        `SELECT ${latestCols} FROM sqp_cron_details ORDER BY ${hasUpdated ? 'dtUpdatedOn DESC,' : ''} ID DESC LIMIT 1`);
      out.B.latestJob = latest[0] || null;
      if (out.B.latestJob && out.B.latestJob.dtUpdatedOn) {
        out.B.latestJobAgeDays = Math.round(
          (Date.now() - new Date(out.B.latestJob.dtUpdatedOn).getTime()) / 86400000 * 10
        ) / 10;
      }

      for (const period of ['Weekly', 'Monthly', 'Quarterly']) {
        const col = `${period}SQPDataPullStatus`;
        if (await columnExists(conn, dbname, 'sqp_cron_details', col)) {
          const ps = await q(conn, `
            SELECT SUM(${col}=0) AS p0, SUM(${col}=1) AS p1, SUM(${col}=2) AS p2,
                   SUM(${col}=3) AS p3, SUM(${col} IS NULL) AS pnull
            FROM sqp_cron_details`);
          out.B[`${period}Pull`] = {
            pending: Number(ps[0].p0 || 0), success: Number(ps[0].p1 || 0),
            failure: Number(ps[0].p2 || 0), permanent: Number(ps[0].p3 || 0),
            null: Number(ps[0].pnull || 0),
          };
        }
      }

      if (sellerCol) {
        out.B.sellersWithAnyCron = Number((await q(conn,
          `SELECT COUNT(DISTINCT \`${sellerCol}\`) AS c FROM sqp_cron_details`))[0].c);
        if (hasSeller) {
          out.B.mwsSellersWithZeroCron = Number((await q(conn, `
            SELECT COUNT(*) AS c FROM seller s
            WHERE s.isMwsUser=1
              AND NOT EXISTS (SELECT 1 FROM sqp_cron_details c WHERE c.\`${sellerCol}\` = s.ID)`))[0].c);
        }
      }

      if (hasUpdated) {
        const stale = await q(conn, `
          SELECT MAX(dtUpdatedOn) AS maxUpdated,
                 SUM(dtUpdatedOn >= NOW() - INTERVAL 7 DAY) AS jobsUpdated7d,
                 SUM(dtUpdatedOn < NOW() - INTERVAL 7 DAY OR dtUpdatedOn IS NULL) AS jobsStaleOrNull
          FROM sqp_cron_details`);
        out.B.maxUpdated = stale[0].maxUpdated;
        out.B.jobsUpdated7d = Number(stale[0].jobsUpdated7d || 0);
        out.B.jobsStaleOrNull = Number(stale[0].jobsStaleOrNull || 0);
        out.B.staleOver7d = !stale[0].maxUpdated ||
          (Date.now() - new Date(stale[0].maxUpdated).getTime()) > 7 * 86400000;
      }
    } else {
      out.B.totalJobs = 0;
      out.B.missing = true;
    }

    // C
    if (hasLogs && await columnExists(conn, dbname, 'sqp_cron_logs', 'Status')) {
      const hasDt = await columnExists(conn, dbname, 'sqp_cron_logs', 'dtCreatedOn');
      if (hasDt) {
        out.C.logFail7d = Number((await q(conn,
          `SELECT COUNT(*) AS c FROM sqp_cron_logs WHERE Status=2 AND dtCreatedOn >= NOW() - INTERVAL 7 DAY`))[0].c);
        out.C.logFail30dOrAll = Number((await q(conn,
          `SELECT COUNT(*) AS c FROM sqp_cron_logs WHERE Status=2 AND dtCreatedOn >= NOW() - INTERVAL 30 DAY`))[0].c);
        out.C.topMessages = await q(conn, `
          SELECT LEFT(IFNULL(Message,'(null)'),80) AS msg, COUNT(*) AS c
          FROM sqp_cron_logs WHERE Status=2 AND dtCreatedOn >= NOW() - INTERVAL 30 DAY
          GROUP BY LEFT(IFNULL(Message,'(null)'),80) ORDER BY c DESC LIMIT 10`);
      } else {
        out.C.logFail30dOrAll = Number((await q(conn,
          `SELECT COUNT(*) AS c FROM sqp_cron_logs WHERE Status=2`))[0].c);
        out.C.topMessages = await q(conn, `
          SELECT LEFT(IFNULL(Message,'(null)'),80) AS msg, COUNT(*) AS c
          FROM sqp_cron_logs WHERE Status=2
          GROUP BY LEFT(IFNULL(Message,'(null)'),80) ORDER BY c DESC LIMIT 10`);
      }
    }

    if (hasUrls && await columnExists(conn, dbname, 'sqp_download_urls', 'Status')) {
      // Status may be string FAILED or other
      const dist = await q(conn, `SELECT Status, COUNT(*) AS c FROM sqp_download_urls GROUP BY Status`);
      out.C.downloadStatusDist = dist;
      out.C.downloadFailed = Number((await q(conn, `
        SELECT COUNT(*) AS c FROM sqp_download_urls
        WHERE Status='FAILED' OR Status='failed' OR Status=2 OR Status='2'`))[0].c);
      if (out.C.downloadFailed > 0 && await columnExists(conn, dbname, 'sqp_download_urls', 'ErrorMessage')) {
        out.C.topDownloadErrors = await q(conn, `
          SELECT LEFT(IFNULL(ErrorMessage,'(null)'),80) AS msg, COUNT(*) AS c
          FROM sqp_download_urls
          WHERE Status='FAILED' OR Status='failed' OR Status=2 OR Status='2'
          GROUP BY LEFT(IFNULL(ErrorMessage,'(null)'),80) ORDER BY c DESC LIMIT 10`);
      }
    }

    // Diagnosis
    const needInitial = out.A.asinNeedInitial || 0;
    const activeAsin = out.A.asinActive || 0;
    const mws = out.A.mwsSellers || 0;
    const cronEmpty = !hasCron || (out.B.totalJobs || 0) === 0;
    const stale = out.B.staleOver7d === true;
    const lost = out.A.lostAccessOrNoToken || 0;
    const okTok = out.A.okToken;
    const initRunning = (out.B.statusByType?.initial?.running) || 0;
    const initRetry = (out.B.statusByType?.initial?.retry) || 0;
    const regRunning = (out.B.statusByType?.regular?.running) || 0;
    const regRetry = (out.B.statusByType?.regular?.retry) || 0;
    const regJobs = out.B.regularJobs || 0;
    const initCompleted = (out.B.statusByType?.initial?.completed) || 0;
    const regCompleted = (out.B.statusByType?.regular?.completed) || 0;
    const asinInitStuck = !!out.A.asinInit && needInitial > 0 &&
      (out.A.asinInit.inProgress1 + out.A.asinInit.pending0 + out.A.asinInit.null) > 0;

    out.flags = {
      needInitialButCronEmptyOrStale: needInitial > 0 && (cronEmpty || stale),
      mwsButZeroCron: mws > 0 && (cronEmpty || out.B.mwsSellersWithZeroCron === mws),
      sqpTablesMissing: !hasCron && !hasLogs,
      noActiveAsins: mws > 0 && activeAsin === 0,
      authHeavy: mws > 0 && okTok != null && lost >= Math.max(1, mws * 0.8),
    };

    if (!hasCron && !hasLogs) out.diagnosis = 'sqp_tables_missing';
    else if (mws === 0) out.diagnosis = 'no_mws_sellers';
    else if (out.flags.noActiveAsins) out.diagnosis = 'no_active_ASINs';
    else if (out.flags.authHeavy && cronEmpty) out.diagnosis = 'auth_skip';
    else if (cronEmpty && mws > 0) out.diagnosis = 'never_started';
    else if (stale && needInitial > 0) out.diagnosis = 'initial_stuck_stale';
    else if (stale && regJobs > 0) out.diagnosis = 'regular_stuck_stale';
    else if (asinInitStuck && (initRunning + initRetry > 0 || (activeAsin > 0 && needInitial > activeAsin * 0.3)))
      out.diagnosis = 'initial_stuck';
    else if ((regRunning + regRetry > 0) && (out.C.logFail7d || 0) > 20 && regCompleted === 0)
      out.diagnosis = 'regular_stuck';
    else if (out.flags.authHeavy) out.diagnosis = 'auth_skip';
    else if (stale) out.diagnosis = 'stale_inactive';
    else if ((out.B.jobsUpdated7d || 0) > 0 && (regCompleted + initCompleted) > 0) out.diagnosis = 'healthy';
    else if ((out.B.jobsUpdated7d || 0) > 0) out.diagnosis = 'active_partial';
    else out.diagnosis = 'unclear';
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
    out.diagnosis = 'query_error';
  } finally {
    await conn.end();
  }
  return out;
}

(async () => {
  const ts = new Date().toISOString();
  console.error(`[sqp-diag2] start ${ts}`);

  const master = await mysql.createConnection({
    host, port, user, password, database: MASTER, connectTimeout: 20000,
  });

  // All DB names from master, intersect with schemas that exist on this host
  const listed = await q(master, `
    SELECT DISTINCT DB_Name AS dbname, DB_AppType AS appType
    FROM user_databases
    WHERE DB_Name IS NOT NULL AND DB_Name <> ''
    ORDER BY DB_Name`);
  const schemas = await q(master, `SELECT SCHEMA_NAME AS n FROM information_schema.schemata`);
  const schemaSet = new Set(schemas.map(s => s.n));
  await master.end();

  const onHost = listed.filter(t => schemaSet.has(t.dbname));
  const missingOnHost = listed.filter(t => !schemaSet.has(t.dbname)).map(t => t.dbname);

  console.error(`[sqp-diag2] listed=${listed.length} onHost=${onHost.length} missingOnHost=${missingOnHost.length}`);

  const results = [];
  let i = 0;
  for (const t of onHost) {
    i++;
    process.stderr.write(`[${i}/${onHost.length}] ${t.dbname} ... `);
    const r = await diagnoseTenant(t.dbname);
    r.appType = t.appType;
    process.stderr.write(`${r.diagnosis}${r.error ? ' ERR:' + r.error.slice(0, 80) : ''}\n`);
    results.push(r);
  }

  // also record missing-on-host as unreachable for inventory
  for (const db of missingOnHost) {
    results.push({
      dbname: db, reachable: false, diagnosis: 'db_not_on_this_rds',
      error: 'Schema not present on amazon-api RDS', missingTables: [], A: {}, B: {}, C: {}, flags: {},
    });
  }

  const reachable = results.filter(r => r.reachable && r.diagnosis !== 'query_error');
  const grand = {
    tenantsListed: listed.length,
    tenantsOnThisRds: onHost.length,
    tenantsMissingOnRds: missingOnHost.length,
    tenantsDiagnosedOk: reachable.length,
    tenantsQueryError: results.filter(r => r.diagnosis === 'query_error').length,
    mwsSellers: sum(reachable, r => r.A.mwsSellers),
    mwsWithSQPDate: sum(reachable, r => r.A.dtLatestSQP_notNull),
    mwsWithoutSQPDate: sum(reachable, r => r.A.dtLatestSQP_null),
    okToken: sum(reachable, r => r.A.okToken),
    lostAccessOrNoToken: sum(reachable, r => r.A.lostAccessOrNoToken),
    brandAnalyticsLost: sum(reachable, r => r.A.brandAnalyticsLost),
    asinActive: sum(reachable, r => r.A.asinActive),
    asinNeedInitial: sum(reachable, r => r.A.asinNeedInitial),
    asinInitCompleted: sum(reachable, r => r.A.asinInit && r.A.asinInit.completed2),
    asinInitPending: sum(reachable, r => r.A.asinInit && (r.A.asinInit.pending0 + r.A.asinInit.null)),
    asinInitInProgress: sum(reachable, r => r.A.asinInit && r.A.asinInit.inProgress1),
    asinInitFailed: sum(reachable, r => r.A.asinInit && r.A.asinInit.failed3),
    initialJobs: sum(reachable, r => r.B.initialJobs),
    regularJobs: sum(reachable, r => r.B.regularJobs),
    initRunning: sum(reachable, r => r.B.statusByType?.initial?.running),
    initCompleted: sum(reachable, r => r.B.statusByType?.initial?.completed),
    initRetry: sum(reachable, r => r.B.statusByType?.initial?.retry),
    regRunning: sum(reachable, r => r.B.statusByType?.regular?.running),
    regCompleted: sum(reachable, r => r.B.statusByType?.regular?.completed),
    regRetry: sum(reachable, r => r.B.statusByType?.regular?.retry),
    weeklyPending: sum(reachable, r => r.B.WeeklyPull?.pending),
    weeklySuccess: sum(reachable, r => r.B.WeeklyPull?.success),
    weeklyFailure: sum(reachable, r => r.B.WeeklyPull?.failure),
    weeklyPermanent: sum(reachable, r => r.B.WeeklyPull?.permanent),
    monthlyPending: sum(reachable, r => r.B.MonthlyPull?.pending),
    monthlySuccess: sum(reachable, r => r.B.MonthlyPull?.success),
    monthlyFailure: sum(reachable, r => r.B.MonthlyPull?.failure),
    quarterlyPending: sum(reachable, r => r.B.QuarterlyPull?.pending),
    quarterlySuccess: sum(reachable, r => r.B.QuarterlyPull?.success),
    quarterlyFailure: sum(reachable, r => r.B.QuarterlyPull?.failure),
    logFail7d: sum(reachable, r => r.C.logFail7d),
    logFail30d: sum(reachable, r => r.C.logFail30dOrAll),
    downloadFailed: sum(reachable, r => r.C.downloadFailed),
    mwsSellersWithZeroCron: sum(reachable, r => r.B.mwsSellersWithZeroCron),
    diagnosisCounts: {},
    missingSqpTables: [],
    flagNeedInitStale: [],
    flagMwsZeroCron: [],
  };

  for (const r of results) {
    if (!r.reachable && r.diagnosis === 'db_not_on_this_rds') continue;
    grand.diagnosisCounts[r.diagnosis] = (grand.diagnosisCounts[r.diagnosis] || 0) + 1;
    if (r.flags?.sqpTablesMissing || (r.missingTables || []).includes('sqp_cron_details')) {
      if ((r.missingTables || []).includes('sqp_cron_details') && (r.missingTables || []).includes('sqp_cron_logs')) {
        grand.missingSqpTables.push(r.dbname);
      }
    }
    if (r.flags?.needInitialButCronEmptyOrStale) grand.flagNeedInitStale.push(r.dbname);
    if (r.flags?.mwsButZeroCron) grand.flagMwsZeroCron.push(r.dbname);
  }

  const msgMap = new Map();
  const dlMap = new Map();
  for (const r of reachable) {
    for (const m of (r.C.topMessages || [])) {
      msgMap.set(m.msg || '(null)', (msgMap.get(m.msg || '(null)') || 0) + Number(m.c || 0));
    }
    for (const m of (r.C.topDownloadErrors || [])) {
      dlMap.set(m.msg || '(null)', (dlMap.get(m.msg || '(null)') || 0) + Number(m.c || 0));
    }
  }

  const compact = results.filter(r => r.reachable || r.diagnosis === 'query_error').map(r => ({
    db: r.dbname,
    appType: r.appType,
    diag: r.diagnosis,
    mws: r.A?.mwsSellers,
    okTok: r.A?.okToken,
    lostAuth: r.A?.lostAccessOrNoToken,
    baLost: r.A?.brandAnalyticsLost,
    sqpDateY: r.A?.dtLatestSQP_notNull,
    sqpDateN: r.A?.dtLatestSQP_null,
    asinAct: r.A?.asinActive,
    needInit: r.A?.asinNeedInitial,
    asinInit: r.A?.asinInit,
    cronInit: r.B?.initialJobs,
    cronReg: r.B?.regularJobs,
    initStat: r.B?.statusByType?.initial,
    regStat: r.B?.statusByType?.regular,
    weekly: r.B?.WeeklyPull,
    monthly: r.B?.MonthlyPull,
    quarterly: r.B?.QuarterlyPull,
    latest: r.B?.latestJob ? {
      id: r.B.latestJob.ID,
      init: r.B.latestJob.iInitialPull,
      st: r.B.latestJob.cronRunningStatus,
      upd: r.B.latestJob.dtUpdatedOn || null,
      ageD: r.B.latestJobAgeDays,
      W: r.B.latestJob.WeeklySQPDataPullStatus,
      M: r.B.latestJob.MonthlySQPDataPullStatus,
      Q: r.B.latestJob.QuarterlySQPDataPullStatus,
    } : null,
    stale7: r.B?.staleOver7d,
    jobs7d: r.B?.jobsUpdated7d,
    mwsZeroCron: r.B?.mwsSellersWithZeroCron,
    fail7: r.C?.logFail7d,
    fail30: r.C?.logFail30dOrAll,
    dlFail: r.C?.downloadFailed,
    flags: r.flags,
    miss: r.missingTables,
    err: r.error,
  }));

  const report = {
    timestamp: ts,
    host,
    masterDb: MASTER,
    note: 'Only schemas present on this RDS were fully diagnosed. user_databases has no host column; 125 names are not on this instance.',
    grand,
    topMessagesGlobal: [...msgMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([msg, c]) => ({ msg, c })),
    topDownloadErrorsGlobal: [...dlMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([msg, c]) => ({ msg, c })),
    tenantsOnHost: compact,
    missingOnThisRdsSample: missingOnHost.slice(0, 30),
    missingOnThisRdsCount: missingOnHost.length,
  };

  const outPath = path.join(__dirname, 'sqp-all-tenants-diag.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  // compact human summary to stdout
  console.log(JSON.stringify({
    timestamp: ts,
    grand,
    topMessagesGlobal: report.topMessagesGlobal,
    topDownloadErrorsGlobal: report.topDownloadErrorsGlobal,
    tenantsOnHost: compact,
  }, null, 2));
  console.error(`[sqp-diag2] wrote ${outPath}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
