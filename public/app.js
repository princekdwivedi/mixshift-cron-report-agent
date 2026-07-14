const form = document.getElementById('report-form');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const summaryBar = document.getElementById('summary-bar');
const servicesEl = document.getElementById('services');
const rawEl = document.getElementById('raw-json');
const rawToggle = document.getElementById('raw-toggle');
const runBtn = document.getElementById('run-btn');
const serviceSelect = document.getElementById('service');
const cronJobSelect = document.getElementById('cronJob');
const jobHint = document.getElementById('job-hint');

let lastReport = null;
let jobsCatalog = null;

const SERVICE_META = {
  sp: {
    label: 'SP API',
    whole: { value: 'sp-api', label: 'All SP API jobs (sp-api)' },
    hint: 'Seller, vendor, and custom SP report types',
  },
  ad: {
    label: 'Ad API',
    whole: { value: 'ad-api', label: 'All Ad API jobs (ad-api)' },
    hint: 'Sponsored ads and DSP report types',
  },
  backend: {
    label: 'Backend',
    whole: { value: 'backend', label: 'All backend jobs (backend)' },
    hint: 'Keyword / backend pipeline jobs',
  },
  sqp: {
    label: 'SQP',
    whole: { value: 'sqp', label: 'All SQP periods (sqp)' },
    hint: 'Search Query Performance pull periods',
  },
  all: {
    label: 'All services',
    whole: { value: 'all', label: 'Everything (all)' },
    hint: 'Runs every service pipeline',
  },
};

const GROUP_LABELS = {
  seller: 'Seller reports',
  vendor: 'Vendor reports',
  custom: 'Custom reports',
  ads: 'Sponsored ads',
  dsp: 'DSP',
  keyword: 'Keyword jobs',
  periods: 'SQP periods',
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(text) {
  const t = String(text || '').toLowerCase();
  let cls = 'warn';
  if (/(success|complete|ok|imported)/.test(t)) cls = 'ok';
  if (/(fail|error|has_failures)/.test(t)) cls = 'fail';
  return `<span class="badge ${cls}">${esc(text ?? '—')}</span>`;
}

function setStatus(message, type = 'loading') {
  statusEl.hidden = !message;
  statusEl.className = `status ${type}`;
  statusEl.textContent = message || '';
}

function kv(items) {
  return `<div class="kv">${items
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('')}</div>`;
}

function tableFromRows(rows, columns) {
  if (!rows?.length) return `<p class="empty">No rows</p>`;
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows
    .slice(0, 40)
    .map((row) => {
      const cells = columns
        .map((c) => {
          let val = row[c.key];
          if (c.key === 'status' || c.key === 'processStatus') return `<td>${statusBadge(val)}</td>`;
          if (c.key === 'message' || c.key === 'error') return `<td class="msg">${esc(val || '—')}</td>`;
          return `<td>${esc(val ?? '—')}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<div style="overflow:auto"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderCron(cron) {
  if (!cron) return `<p class="empty">No cron header found</p>`;
  return kv([
    ['Cron ID', cron.cronId],
    ['Seller ID', cron.sellerId],
    ['Amazon Seller ID', cron.amazonSellerID],
    ['Seller', cron.sellerName],
    ['Running', cron.runningStatus],
    ['Copy complete', cron.copyComplete],
    ['Start', cron.start],
    ['End', cron.end],
    ['Log file', cron.logFileName],
  ]);
}

function renderPullSummary(pull) {
  if (!pull) return '';
  return `
    <h3>SQP pull status</h3>
    ${kv([
      ['Cron running', pull.cronRunning],
      ['Weekly', pull.weekly?.status],
      ['Weekly window', `${pull.weekly?.start || '—'} → ${pull.weekly?.end || '—'}`],
      ['Monthly', pull.monthly?.status],
      ['Monthly window', `${pull.monthly?.start || '—'} → ${pull.monthly?.end || '—'}`],
      ['Quarterly', pull.quarterly?.status],
      ['Quarterly window', `${pull.quarterly?.start || '—'} → ${pull.quarterly?.end || '—'}`],
    ])}
  `;
}

function renderSection(section) {
  const counts = section.counts || {};
  return `
    <div class="pipeline">
      <h3>
        ${esc(section.pipeline || 'pipeline')}
        ${section.fullyDone === true ? statusBadge('Fully done') : ''}
        ${section.fullyDone === false ? statusBadge('Not fully done') : ''}
        ${counts.total != null ? `<span class="badge">${counts.success || 0} ok · ${counts.failure || 0} fail · ${counts.total} logs</span>` : ''}
      </h3>
      ${section.note ? `<p class="empty">${esc(section.note)}</p>` : ''}
      ${renderCron(section.latestCron)}
      ${renderPullSummary(section.pullSummary)}
      ${section.adCopyStatus?.length ? `
        <h3>Ad copy status (backend)</h3>
        ${tableFromRows(section.adCopyStatus, [
          { key: 'cronId', label: 'Cron ID' },
          { key: 'runningStatus', label: 'Running' },
          { key: 'copyComplete', label: 'Copy' },
          { key: 'fullyDone', label: 'Fully done' },
          { key: 'end', label: 'End' },
        ])}
      ` : ''}
      <h3>Failures</h3>
      ${tableFromRows(section.failures || [], [
        { key: 'id', label: 'ID' },
        { key: 'reportType', label: 'Report' },
        { key: 'status', label: 'Status' },
        { key: 'message', label: 'Message' },
        { key: 'end', label: 'End' },
      ])}
      <h3>Logs</h3>
      ${tableFromRows(section.logs || [], [
        { key: 'id', label: 'ID' },
        { key: 'reportType', label: 'Report / Type' },
        { key: 'action', label: 'Action' },
        { key: 'status', label: 'Status' },
        { key: 'recordCount', label: 'Records' },
        { key: 'message', label: 'Message' },
        { key: 'end', label: 'End' },
      ])}
      ${section.downloads?.length ? `
        <h3>Downloads</h3>
        ${tableFromRows(section.downloads, [
          { key: 'id', label: 'ID' },
          { key: 'status', label: 'Status' },
          { key: 'processStatus', label: 'Process' },
          { key: 'error', label: 'Error' },
          { key: 'updated', label: 'Updated' },
        ])}
      ` : ''}
    </div>
  `;
}

function renderReport(report) {
  lastReport = report;
  resultsEl.hidden = false;
  rawToggle.disabled = false;

  const s = report.summary || {};
  const t = s.totals || {};
  summaryBar.innerHTML = `
    <div class="verdict ${esc(s.verdict || '')}">
      <span class="k" style="color:var(--muted);font-size:0.75rem">Verdict</span>
      <strong>${esc(s.verdict || '—')}</strong>
      ${statusBadge(s.verdict)}
    </div>
    <div class="totals">
      <div class="stat success"><div class="label">Success</div><div class="value">${esc(t.success ?? 0)}</div></div>
      <div class="stat failure"><div class="label">Failure</div><div class="value">${esc(t.failure ?? 0)}</div></div>
      <div class="stat"><div class="label">Other</div><div class="value">${esc(t.other ?? 0)}</div></div>
      <div class="stat"><div class="label">Total logs</div><div class="value">${esc(t.total ?? 0)}</div></div>
      <div class="meta">
        DB ${esc(report.input?.dbname)} · Seller ${esc(report.seller?.sellerId)} / ${esc(report.seller?.amazonSellerId)}
        ${report.seller?.sellerName ? ` · ${esc(report.seller.sellerName)}` : ''}
        · Job ${esc(report.input?.cronJobName)}
        · ${esc(report.generatedAt)}
      </div>
    </div>
  `;

  servicesEl.innerHTML = (report.services || [])
    .map((svc) => `
      <article class="service-card">
        <div class="service-head">
          <h2>${esc(svc.service)}</h2>
          <span class="badge">${(svc.sections || []).length} section(s)</span>
        </div>
        ${(svc.sections || []).map(renderSection).join('') || '<p class="empty" style="padding:1rem">No sections</p>'}
      </article>
    `)
    .join('');

  rawEl.textContent = JSON.stringify(report, null, 2);
}

function optionGroupsHtml(groups) {
  return groups
    .map((group) => {
      const opts = group.jobs
        .map((job) => `<option value="${esc(job)}">${esc(job)}</option>`)
        .join('');
      return `<optgroup label="${esc(group.label)}">${opts}</optgroup>`;
    })
    .join('');
}

function jobsForService(service) {
  const jobs = jobsCatalog || {};
  if (service === 'sp') {
    const sp = jobs['sp-api'] || {};
    return [
      { label: GROUP_LABELS.seller, jobs: sp.seller || [] },
      { label: GROUP_LABELS.vendor, jobs: sp.vendor || [] },
      { label: GROUP_LABELS.custom, jobs: sp.custom || [] },
    ].filter((g) => g.jobs.length);
  }
  if (service === 'ad') {
    const ad = jobs['ad-api'] || {};
    return [
      { label: GROUP_LABELS.ads, jobs: ad.ads || [] },
      { label: GROUP_LABELS.dsp, jobs: ad.dsp || [] },
    ].filter((g) => g.jobs.length);
  }
  if (service === 'backend') {
    const backend = jobs.backend || {};
    return [
      { label: GROUP_LABELS.keyword, jobs: backend.keyword || [] },
    ].filter((g) => g.jobs.length);
  }
  if (service === 'sqp') {
    return [
      { label: GROUP_LABELS.periods, jobs: jobs.sqp || [] },
    ].filter((g) => g.jobs.length);
  }
  return [];
}

function populateCronJobs(service, preferredJob) {
  const meta = SERVICE_META[service];
  if (!meta) {
    cronJobSelect.disabled = true;
    cronJobSelect.innerHTML = '<option value="">Select a service first…</option>';
    jobHint.textContent = 'Jobs appear after you pick a service';
    return;
  }

  cronJobSelect.disabled = false;
  jobHint.textContent = meta.hint;

  const groups = jobsForService(service);
  const whole = `<option value="${esc(meta.whole.value)}">${esc(meta.whole.label)}</option>`;
  const placeholder = '<option value="" disabled>Choose a cron job…</option>';

  if (service === 'all') {
    cronJobSelect.innerHTML = `${placeholder}${whole}`;
  } else {
    cronJobSelect.innerHTML = `${placeholder}${whole}${optionGroupsHtml(groups)}`;
  }

  const options = [...cronJobSelect.options].map((o) => o.value);
  if (preferredJob && options.includes(preferredJob)) {
    cronJobSelect.value = preferredJob;
  } else {
    cronJobSelect.value = meta.whole.value;
  }
}

function saveForm() {
  localStorage.setItem(
    'cronReportForm',
    JSON.stringify({
      dbname: document.getElementById('dbname').value,
      sellerId: document.getElementById('sellerId').value,
      cronJob: cronJobSelect.value,
      service: serviceSelect.value,
    })
  );
}

async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    jobsCatalog = data.jobs || {};
  } catch {
    jobsCatalog = {};
  }

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('cronReportForm') || '{}');
  } catch { /* ignore */ }

  if (saved.dbname) document.getElementById('dbname').value = saved.dbname;
  if (saved.sellerId) document.getElementById('sellerId').value = saved.sellerId;

  const service = saved.service && SERVICE_META[saved.service] ? saved.service : '';
  if (service) {
    serviceSelect.value = service;
    populateCronJobs(service, saved.cronJob);
  } else {
    populateCronJobs('');
  }
}

serviceSelect.addEventListener('change', () => {
  populateCronJobs(serviceSelect.value);
  saveForm();
});

cronJobSelect.addEventListener('change', saveForm);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const service = serviceSelect.value;
  const cronJobName = cronJobSelect.value.trim();
  if (!service || !cronJobName) {
    setStatus('Select a service and cron job', 'error');
    return;
  }

  const payload = {
    dbname: document.getElementById('dbname').value.trim(),
    sellerId: document.getElementById('sellerId').value.trim(),
    cronJobName,
    // Whole-service aliases already encode the service; force only for specific jobs
    service: ['sp-api', 'ad-api', 'backend', 'sqp', 'all'].includes(cronJobName.toLowerCase())
      ? undefined
      : service,
  };

  runBtn.disabled = true;
  setStatus('Querying database…', 'loading');
  resultsEl.hidden = true;
  saveForm();

  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    setStatus('');
    renderReport(data);
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    runBtn.disabled = false;
  }
});

rawToggle.addEventListener('click', () => {
  if (!lastReport) return;
  rawEl.hidden = !rawEl.hidden;
});

form.addEventListener('change', saveForm);

loadJobs();
