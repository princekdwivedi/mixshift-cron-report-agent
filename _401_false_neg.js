const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const h = process.env.DB_HOST, p = process.env.DB_PORT, u = process.env.DB_USER, pw = process.env.DB_PASSWORD;
async function q(c, s, pa = []) { const [r] = await c.query(s, pa); return r; }
(async () => {
  const dbs = ['amzell', 'dashamazon', 'armr', 'jayfranco'];
  const out = [];
  for (const db of dbs) {
    const c = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: db });
    const hasCol = (await q(c, `SELECT 1 ok FROM information_schema.columns WHERE table_schema=? AND table_name='seller' AND column_name='dtLatestAdPullDate'`, [db])).length;
    const pullCol = hasCol ? 's.dtLatestAdPullDate' : 'NULL';
    const oauth = (await q(c, `SELECT table_name t FROM information_schema.tables WHERE table_schema=? AND table_name IN ('tbl_mws_oauth_token','mws_oauth_token') LIMIT 1`, [db]))[0]?.t;
    const rows = await q(c, `
      SELECT s.ID, s.Name, s.isAdLostAccess, s.idUserAccount, ${pullCol} lastAdPull,
             COUNT(f.ID) f401
      FROM seller s
      JOIN cron_failure_logs f ON (f.SellerID=s.ID OR f.SellerID=s.AmazonSellerID)
      WHERE f.reportStartDateTime>='2026-07-16' AND f.reportStartDateTime<'2026-07-17'
        AND f.cronResponse LIKE '%401 Unauthorized%' AND IFNULL(s.isAdLostAccess,0)=0
      GROUP BY s.ID, s.Name, s.isAdLostAccess, s.idUserAccount, lastAdPull
      ORDER BY f401 DESC LIMIT 10`);
    for (const r of rows) {
      let tok = null;
      if (oauth && r.idUserAccount) {
        tok = (await q(c, `SELECT isActive, expire_at, dtCreatedOn FROM \`${oauth}\` WHERE idUserAccount=? ORDER BY ID DESC LIMIT 1`, [r.idUserAccount]))[0];
      }
      out.push({ db, sellerId: r.ID, name: r.Name, f401: Number(r.f401), lastAdPull: r.lastAdPull, tokenActive: tok ? Number(tok.isActive) : null, tokenExpiry: tok?.expire_at, tokenUpdated: tok?.dtCreatedOn });
    }
    await c.end();
  }
  console.log(JSON.stringify(out, null, 2));
})();
