const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'dash_applications',
    connectTimeout: 20000,
  });

  const [tenants] = await conn.query(`
    SELECT DISTINCT
      db.DB_Name AS dbname,
      GROUP_CONCAT(DISTINCT u.ID ORDER BY u.ID) AS userIds
    FROM user_databases db
    INNER JOIN user_database_mapping map ON map.MappedDB_ID = db.DB_ID
    INNER JOIN users u ON u.ID = map.UserID AND u.isDeleted = 0
    WHERE db.DB_Name IS NOT NULL
      AND db.DB_Name <> ''
      AND db.DB_AppType = 1
    GROUP BY db.DB_Name
    ORDER BY db.DB_Name
  `);

  const [schemas] = await conn.query(
    `SELECT SCHEMA_NAME AS n FROM information_schema.schemata`
  );
  const schemaSet = new Set(schemas.map((s) => s.n));
  const onHost = tenants.filter((t) => schemaSet.has(t.dbname));
  const notOnHost = tenants
    .filter((t) => !schemaSet.has(t.dbname))
    .map((t) => t.dbname);

  const missing = [];
  const hasCol = [];
  const noSeller = [];
  const errors = [];

  for (const t of onHost) {
    try {
      const [sellerRows] = await conn.query(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = ? AND table_name = 'seller' LIMIT 1`,
        [t.dbname]
      );
      if (!sellerRows.length) {
        noSeller.push({ dbname: t.dbname, userIds: t.userIds });
        continue;
      }

      const [colRows] = await conn.query(
        `SELECT 1 AS ok FROM information_schema.columns
         WHERE table_schema = ?
           AND table_name = 'seller'
           AND column_name = 'dtLatestSQPPullDate'
         LIMIT 1`,
        [t.dbname]
      );

      if (!colRows.length) {
        missing.push({ dbname: t.dbname, userIds: t.userIds });
      } else {
        hasCol.push(t.dbname);
      }
    } catch (e) {
      errors.push({
        dbname: t.dbname,
        error: String(e.message || e).slice(0, 200),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        tenantsMappedAppType1: tenants.length,
        onThisHost: onHost.length,
        notOnThisHost: notOnHost.length,
        hasColumn: hasCol.length,
        missingColumnCount: missing.length,
        missingColumn: missing,
        noSellerTable: noSeller,
        errors,
        notOnThisHostSample: notOnHost.slice(0, 30),
      },
      null,
      2
    )
  );

  await conn.end();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
