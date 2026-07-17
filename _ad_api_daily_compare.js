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
  const days = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'];
  const out = {};
  for (const d of days) out[d] = { total: 0, success: 0, failure: 0 };
  for (const db of tenants.filter((d) => schemas.has(d))) {
    let c;
    try { c = await mysql.createConnection({ host: h, port: p, user: u, password: pw, database: db, connectTimeout: 8000 }); } catch { continue; }
    try {
      const has = (await q(c, `SELECT 1 ok FROM information_schema.tables WHERE table_schema=? AND table_name='cron_all_logs' LIMIT 1`, [db])).length;
      if (!has) { await c.end(); continue; }
      for (const d of days) {
        const end = new Date(d); end.setUTCDate(end.getUTCDate() + 1);
        const s = await q(c, `SELECT COUNT(*) total, SUM(iStatus=1) ok, SUM(iStatus=2) fail FROM cron_all_logs WHERE reportStartDateTime>=? AND reportStartDateTime<?`, [d, end.toISOString().slice(0, 10)]);
        out[d].total += Number(s[0].total || 0);
        out[d].success += Number(s[0].ok || 0);
        out[d].failure += Number(s[0].fail || 0);
      }
    } catch {} finally { await c.end(); }
  }
  for (const d of days) out[d].failRate = out[d].total ? ((out[d].failure / out[d].total) * 100).toFixed(1) + '%' : null;
  console.log(JSON.stringify(out, null, 2));
})();
