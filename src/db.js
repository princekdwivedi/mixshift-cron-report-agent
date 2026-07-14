const mysql = require('mysql2/promise');

function getDbConfig(dbname) {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD ?? '';

  if (!dbname) {
    throw new Error('dbname is required');
  }

  return {
    host,
    port,
    user,
    password,
    database: dbname,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true,
    dateStrings: true,
  };
}

async function withConnection(dbname, fn) {
  const pool = mysql.createPool(getDbConfig(dbname));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function query(pool, sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function tableExists(pool, tableName) {
  const rows = await query(
    pool,
    `SELECT 1 AS ok
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = :tableName
     LIMIT 1`,
    { tableName }
  );
  return rows.length > 0;
}

module.exports = {
  getDbConfig,
  withConnection,
  query,
  tableExists,
};
