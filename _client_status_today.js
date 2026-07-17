const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const h = process.env.DB_HOST, p = process.env.DB_PORT, u = process.env.DB_USER, pw = process.env.DB_PASSWORD;

async function q(c, s, pa = []) { const [r] = await c.query(s, pa); return r; }

(async () => {
  const m = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: 'dash_applications' });
  const tenants = (await q(m, `SELECT DISTINCT DB_Name dbname FROM user_databases WHERE DB_Name IS NOT NULL AND DB_Name<>''`)).map((x) => x.dbname);
  const schemas = new Set((await q(m, `SELECT SCHEMA_NAME n FROM information_schema.schemata`)).map((x) => x.n));
  await m.end();

  const cronStats = {
    jul15: { crons: 0, complete: 0, running: 0, retryReady: 0, retryRunning: 0, copyIncomplete: 0, tenants: 0 },
    jul16: { crons: 0, complete: 0, running: 0, retryReady: 0, retryRunning: 0, copyIncomplete: 0, tenants: 0 },
  };
  const logStats = { jul15: { total: 0, ok: 0, fail: 0, f401: 0 }, jul16: { total: 0, ok: 0, fail: 0, f401: 0 } };
  const retryQueueJul16 = [];
  const auth401Sellers = [];

  for (const db of tenants.filter((d) => schemas.has(d))) {
    let c;
    try { c = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: db, connectTimeout: 8000 }); } catch { continue; }
    try {
      const hasCron = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_details' LIMIT 1`, [db])).length;
      if (!hasCron) continue;

      for (const [label, start] of [['jul15', '2026-07-15'], ['jul16', '2026-07-16']]) {
        const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
        const rows = await q(c, `
          SELECT COUNT(*) cnt,
                 SUM(iCronRunningStatus=2) complete,
                 SUM(iCronRunningStatus=1) running,
                 SUM(iCronRunningStatus=3) retryReady,
                 SUM(iCronRunningStatus=4) retryRunning,
                 SUM(iCronRunningStatus=2 AND IFNULL(iCronCompleteCopyStatus,0)<>1) copyInc
          FROM cron_details WHERE dtCronStartDate >= ? AND dtCronStartDate < ?`, [start, end.toISOString().slice(0, 10)]);
        if (Number(rows[0].cnt) > 0) {
          cronStats[label].tenants++;
          cronStats[label].crons += Number(rows[0].cnt);
          cronStats[label].complete += Number(rows[0].complete || 0);
          cronStats[label].running += Number(rows[0].running || 0);
          cronStats[label].retryReady += Number(rows[0].retryReady || 0);
          cronStats[label].retryRunning += Number(rows[0].retryRunning || 0);
          cronStats[label].copyIncomplete += Number(rows[0].copyInc || 0);
        }
      }

      const rq = await q(c, `
        SELECT COUNT(*) cnt FROM cron_details
        WHERE dtCronStartDate >= '2026-07-16' AND dtCronStartDate < '2026-07-17'
          AND (iCronRunningStatus IN (3,4)
               OR IFNULL(iRetryStatus_API_Error,0)=2 OR IFNULL(iRetryStatus_Report_Error,0)=2
               OR (iCronRunningStatus=2 AND IFNULL(iCronCompleteCopyStatus,0)<>1))`);
      if (Number(rq[0].cnt) > 0) retryQueueJul16.push({ db, count: Number(rq[0].cnt) });

      const hasLogs = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_all_logs' LIMIT 1`, [db])).length;
      if (hasLogs) {
        for (const [label, start] of [['jul15', '2026-07-15'], ['jul16', '2026-07-16']]) {
          const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
          const s = await q(c, `SELECT COUNT(*) total, SUM(iStatus=1) ok, SUM(iStatus=2) fail FROM cron_all_logs WHERE reportStartDateTime>=? AND reportStartDateTime<?`, [start, end.toISOString().slice(0, 10)]);
          logStats[label].total += Number(s[0].total || 0);
          logStats[label].ok += Number(s[0].ok || 0);
          logStats[label].fail += Number(s[0].fail || 0);
        }
      }

      const hasFail = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_failure_logs' LIMIT 1`, [db])).length;
      const hasSeller = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='seller' LIMIT 1`, [db])).length;
      if (hasFail) {
        const c401 = await q(c, `SELECT COUNT(*) c FROM cron_failure_logs WHERE reportStartDateTime >= '2026-07-16' AND reportStartDateTime < '2026-07-17' AND cronResponse LIKE '%401 Unauthorized%'`);
        logStats.jul16.f401 += Number(c401[0].c || 0);
      }
      if (hasFail && hasSeller && (await q(c, `SELECT 1 ok FROM information_schema.columns WHERE table_schema=? AND table_name='seller' AND column_name='isAdLostAccess'`, [db])).length) {
        const rows = await q(c, `
          SELECT s.ID, s.Name, s.MerchantAlias, s.isAdLostAccess,
                 COUNT(DISTINCT f.ID) fail401cnt,
                 MAX(c.dtCronEndDate) lastCronEnd,
                 MAX(c.iCronRunningStatus) maxCronStatus
          FROM cron_failure_logs f
          JOIN seller s ON (s.ID = f.SellerID OR s.AmazonSellerID = f.SellerID)
          LEFT JOIN cron_details c ON c.ID = f.iCronID
          WHERE f.reportStartDateTime >= '2026-07-16' AND f.reportStartDateTime < '2026-07-17'
            AND f.cronResponse LIKE '%401 Unauthorized%'
          GROUP BY s.ID, s.Name, s.MerchantAlias, s.isAdLostAccess`);
        for (const r of rows) auth401Sellers.push({ db, sellerId: r.ID, name: r.Name || r.MerchantAlias, lostAccess: Number(r.isAdLostAccess), fail401: Number(r.fail401cnt), lastCronEnd: r.lastCronEnd, cronStatus: r.maxCronStatus });
      }

      // token check for jul16 401 sellers - oauth table
      const oauthTable = (await q(c, `SELECT table_name t FROM information_schema.tables WHERE table_schema=? AND table_name IN ('tbl_mws_oauth_token','mws_oauth_token') LIMIT 1`, [db]))[0]?.t;
      if (oauthTable && auth401Sellers.length) {
        // done per seller below in aggregate
      }
    } catch {} finally { await c.end(); }
  }

  // token status for 401 sellers
  for (const s of auth401Sellers.filter((x) => x.lostAccess === 0).slice(0, 30)) {
    let c;
    try { c = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: s.db, connectTimeout: 8000 }); } catch { continue; }
    try {
      const oauthTable = (await q(c, `SELECT table_name t FROM information_schema.tables WHERE table_schema=? AND table_name IN ('tbl_mws_oauth_token','mws_oauth_token') LIMIT 1`, [s.db]))[0]?.t;
      if (!oauthTable) continue;
      const seller = await q(c, `SELECT idUserAccount FROM seller WHERE ID=? LIMIT 1`, [s.sellerId]);
      if (!seller[0]?.idUserAccount) continue;
      const tok = await q(c, `SELECT isActive, expire_at, dtCreatedOn FROM \`${oauthTable}\` WHERE idUserAccount=? ORDER BY ID DESC LIMIT 1`, [seller[0].idUserAccount]);
      s.tokenActive = tok[0] ? Number(tok[0].isActive) : null;
      s.tokenExpiry = tok[0]?.expire_at || null;
      s.tokenUpdated = tok[0]?.dtCreatedOn || null;
    } catch {} finally { await c.end(); }
  }

  auth401Sellers.sort((a, b) => b.fail401 - a.fail401);
  retryQueueJul16.sort((a, b) => b.count - a.count);

  const lostMarked = auth401Sellers.filter((x) => x.lostAccess === 1).length;
  const notLostMarked = auth401Sellers.filter((x) => x.lostAccess === 0).length;
  const notLostWithActiveToken = auth401Sellers.filter((x) => x.lostAccess === 0 && x.tokenActive === 1).length;

  for (const k of ['jul15', 'jul16']) {
    cronStats[k].completePct = cronStats[k].crons ? ((cronStats[k].complete / cronStats[k].crons) * 100).toFixed(1) + '%' : '0%';
    cronStats[k].retryQueue = cronStats[k].retryReady + cronStats[k].retryRunning;
    logStats[k].failRate = logStats[k].total ? ((logStats[k].fail / logStats[k].total) * 100).toFixed(1) + '%' : '0%';
  }

  console.log(JSON.stringify({
    cronStats,
    logStats,
    retryQueueJul16Total: retryQueueJul16.reduce((s, x) => s + x.count, 0),
    retryQueueJul16Top: retryQueueJul16.slice(0, 12),
    auth401Jul16: {
      failureLogCount: logStats.jul16.f401,
      uniqueSellersWith401: auth401Sellers.length,
      markedLostAccess: lostMarked,
      notMarkedLostAccess: notLostMarked,
      notLostButActiveToken: notLostWithActiveToken,
      topSellers: auth401Sellers.slice(0, 15),
      likelyFalseNegatives: auth401Sellers.filter((x) => x.lostAccess === 0 && x.tokenActive === 1).slice(0, 10),
    },
  }, null, 2));
})();
