const path = require('path');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const { getCronReport, listAllJobs } = require('./index');

const PORT = Number(process.env.PORT || 3847);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (req.method === 'GET' && url.pathname === '/styles.css') {
      return sendFile(res, path.join(PUBLIC_DIR, 'styles.css'));
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app.js'));
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return sendJson(res, 200, { ok: true, jobs: listAllJobs() });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'cron-report-agent' });
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      const body = await readBody(req);
      const report = await getCronReport({
        dbname: body.dbname,
        sellerId: body.sellerId,
        cronJobName: body.cronJobName || body.cronJob,
        service: body.service,
      });
      return sendJson(res, 200, report);
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      const report = await getCronReport({
        dbname: url.searchParams.get('dbname'),
        sellerId: url.searchParams.get('sellerId'),
        cronJobName: url.searchParams.get('cronJob') || url.searchParams.get('cronJobName'),
        service: url.searchParams.get('service') || undefined,
      });
      return sendJson(res, 200, report);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Cron Report UI → http://localhost:${PORT}`);
});
