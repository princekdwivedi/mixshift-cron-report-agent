const { query, tableExists } = require('./db');
const { CRON_RUNNING, LOG_STATUS, label, summarizeCounts } = require('./status');

async function resolveSeller(pool, sellerId) {
  const id = String(sellerId).trim();
  if (!id) return null;

  // Prefer seller table; column names vary (Name / MerchantAlias — not SellerName)
  if (await tableExists(pool, 'seller')) {
    const cols = await query(
      pool,
      `SELECT COLUMN_NAME AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'seller'`,
      {}
    );
    const names = new Set(cols.map((c) => c.name));
    const selectParts = ['ID', 'AmazonSellerID'];
    if (names.has('Name')) selectParts.push('Name');
    if (names.has('MerchantAlias')) selectParts.push('MerchantAlias');
    if (names.has('MarketPlaceID')) selectParts.push('MarketPlaceID');
    if (names.has('idUserAccount')) selectParts.push('idUserAccount');
    if (names.has('ProfileId')) selectParts.push('ProfileId');

    const whereParts = [];
    if (names.has('ID')) whereParts.push('ID = :id');
    if (names.has('AmazonSellerID')) whereParts.push('AmazonSellerID = :id');
    if (!whereParts.length) {
      return { sellerId: id, amazonSellerId: id, sellerName: null, matches: [] };
    }

    const byPk = await query(
      pool,
      `SELECT ${selectParts.join(', ')}
       FROM seller WHERE (${whereParts.join(' OR ')}) LIMIT 5`,
      { id }
    );
    if (byPk.length) {
      return {
        sellerId: byPk[0].ID,
        amazonSellerId: byPk[0].AmazonSellerID,
        sellerName: byPk[0].Name || byPk[0].MerchantAlias || null,
        matches: byPk,
      };
    }
  }
  return { sellerId: id, amazonSellerId: id, sellerName: null, matches: [] };
}

async function fetchHeader(pool, table, seller, limit = 5) {
  if (!(await tableExists(pool, table))) return [];
  const cols = await query(
    pool,
    `SELECT COLUMN_NAME AS name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = :table`,
    { table }
  );
  const names = new Set(cols.map((c) => c.name));
  const whereParts = [];
  if (names.has('SellerID')) whereParts.push('SellerID = :sellerId OR SellerID = :amazonSellerId');
  if (names.has('AmazonSellerID')) whereParts.push('AmazonSellerID = :sellerId OR AmazonSellerID = :amazonSellerId');
  if (!whereParts.length) return [];

  return query(
    pool,
    `SELECT * FROM \`${table}\`
     WHERE (${whereParts.join(' OR ')})
     ORDER BY ID DESC LIMIT ${Number(limit)}`,
    { sellerId: seller.sellerId, amazonSellerId: seller.amazonSellerId }
  );
}

async function fetchLogs(pool, table, seller, reportType, limit = 50) {
  if (!(await tableExists(pool, table))) return [];
  const cols = await query(
    pool,
    `SELECT COLUMN_NAME AS name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = :table`,
    { table }
  );
  const names = new Set(cols.map((c) => c.name));
  const where = [];
  if (names.has('SellerID')) where.push('(SellerID = :sellerId OR SellerID = :amazonSellerId)');
  if (names.has('AmazonSellerID')) where.push('(AmazonSellerID = :sellerId OR AmazonSellerID = :amazonSellerId)');
  if (!where.length && names.has('CronJobID')) {
    // SQP logs join via CronJobID — handled separately
    return [];
  }
  let sql = `SELECT * FROM \`${table}\` WHERE (${where.join(' OR ')})`;
  const params = { sellerId: seller.sellerId, amazonSellerId: seller.amazonSellerId };
  if (reportType && names.has('reportType')) {
    sql += ' AND reportType = :reportType';
    params.reportType = reportType;
  }
  sql += ` ORDER BY ID DESC LIMIT ${Number(limit)}`;
  return query(pool, sql, params);
}

async function fetchFailures(pool, table, seller, reportType, limit = 50) {
  return fetchLogs(pool, table, seller, reportType, limit);
}

function mapHeaderSummary(row) {
  if (!row) return null;
  return {
    cronId: row.ID,
    sellerId: row.SellerID ?? null,
    amazonSellerID: row.AmazonSellerID ?? null,
    sellerName: row.SellerName ?? null,
    profileId: row.ProfileId ?? null,
    runningStatus: label(CRON_RUNNING, row.iCronRunningStatus ?? row.cronRunningStatus),
    runningStatusCode: row.iCronRunningStatus ?? row.cronRunningStatus ?? null,
    copyComplete: row.iCronCompleteCopyStatus ?? null,
    retryApi: row.iRetryStatus_API_Error ?? null,
    retryReport: row.iRetryStatus_Report_Error ?? null,
    start: row.dtCronStartDate ?? row.dtCreatedOn ?? null,
    end: row.dtCronEndDate ?? null,
    logFileName: row.logFileName ?? null,
  };
}

function mapLogRows(rows) {
  return rows.map((r) => ({
    id: r.ID,
    cronId: r.iCronID ?? r.CronJobID ?? null,
    reportType: r.reportType ?? r.ReportType ?? null,
    status: label(LOG_STATUS, r.iStatus ?? r.Status),
    statusCode: r.iStatus ?? r.Status ?? null,
    start: r.reportStartDateTime ?? r.dtCreatedOn ?? null,
    end: r.reportEndDateTime ?? r.dtUpdatedOn ?? null,
    recordCount: r.recordCount ?? null,
    message: r.cronResponse ?? r.Message ?? r.ErrorMessage ?? null,
  }));
}

async function reportSp(pool, seller, job) {
  const result = { service: 'sp-api', sections: [] };

  if (job.mode === 'all' || job.mode === 'seller' || job.mode === 'unknown') {
    const headers = await fetchHeader(pool, 'mws_cron_details', seller);
    const reportType = job.mode === 'seller' || job.kind === 'report' ? job.jobName : null;
    const logs = await fetchLogs(pool, 'mws_cron_all_logs', seller, reportType === 'all' ? null : reportType);
    const failures = await fetchFailures(pool, 'mws_cron_failure_logs', seller, reportType === 'all' ? null : reportType);
    result.sections.push({
      pipeline: 'seller',
      latestCron: mapHeaderSummary(headers[0]),
      recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
      logs: mapLogRows(logs),
      failures: mapLogRows(failures),
      counts: summarizeCounts(logs),
    });
  }

  if (job.mode === 'all' || job.mode === 'vendor' || job.mode === 'unknown') {
    const headers = await fetchHeader(pool, 'mws_vendor_cron_details', seller);
    const reportType = job.mode === 'vendor' ? job.jobName : job.mode === 'unknown' ? job.jobName : null;
    const logs = await fetchLogs(pool, 'mws_vendor_cron_all_logs', seller, job.mode === 'all' ? null : reportType);
    const failures = await fetchFailures(pool, 'mws_vendor_cron_failure_logs', seller, job.mode === 'all' ? null : reportType);
    if (headers.length || logs.length || failures.length) {
      result.sections.push({
        pipeline: 'vendor',
        latestCron: mapHeaderSummary(headers[0]),
        recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
        logs: mapLogRows(logs),
        failures: mapLogRows(failures),
        counts: summarizeCounts(logs),
      });
    }
  }

  if (job.mode === 'all' || job.mode === 'custom' || job.mode === 'unknown') {
    const headers = await fetchHeader(pool, 'mws_custom_cron_details', seller);
    const failures = await fetchFailures(
      pool,
      'mws_custom_cron_failure_logs',
      seller,
      job.mode === 'all' ? null : job.jobName
    );
    if (headers.length || failures.length) {
      result.sections.push({
        pipeline: 'custom',
        latestCron: mapHeaderSummary(headers[0]),
        recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
        logs: [],
        failures: mapLogRows(failures),
        counts: summarizeCounts(failures),
      });
    }
  }

  return result;
}

async function reportAd(pool, seller, job) {
  const result = { service: 'ad-api', sections: [] };
  const reportType = job.mode === 'all' ? null : job.jobName;

  if (job.mode === 'all' || job.mode === 'ads' || job.mode === 'unknown') {
    const headers = await fetchHeader(pool, 'cron_details', seller);
    const logs = await fetchLogs(pool, 'cron_all_logs', seller, reportType);
    const failures = await fetchFailures(pool, 'cron_failure_logs', seller, reportType);
    result.sections.push({
      pipeline: 'advertising',
      latestCron: mapHeaderSummary(headers[0]),
      recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
      fullyDone:
        headers[0] &&
        Number(headers[0].iCronRunningStatus) === 2 &&
        Number(headers[0].iCronCompleteCopyStatus) === 1,
      logs: mapLogRows(logs),
      failures: mapLogRows(failures),
      counts: summarizeCounts(logs),
    });
  }

  if (job.mode === 'all' || job.mode === 'dsp' || job.mode === 'unknown') {
    const headers = await fetchHeader(pool, 'dsp_cron_details', seller);
    const logs = await fetchLogs(pool, 'dsp_cron_all_logs', seller, reportType);
    const failures = await fetchFailures(pool, 'dsp_cron_failure_logs', seller, reportType);
    if (headers.length || logs.length || failures.length) {
      result.sections.push({
        pipeline: 'dsp',
        latestCron: mapHeaderSummary(headers[0]),
        recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
        logs: mapLogRows(logs),
        failures: mapLogRows(failures),
        counts: summarizeCounts(logs),
      });
    }
  }

  return result;
}

async function reportBackend(pool, seller, job) {
  const result = { service: 'backend', sections: [] };
  const reportType = job.mode === 'all' || job.mode === 'keyword' ? null : job.jobName;

  const headers = await fetchHeader(pool, 'keyword_cron_details', seller);
  const logs = await fetchLogs(pool, 'keyword_cron_all_logs', seller, reportType);
  const failures = await fetchFailures(pool, 'keyword_cron_failure_logs', seller, reportType);

  // Also surface AD copy status (backend owns copy completion)
  const adHeaders = await fetchHeader(pool, 'cron_details', seller, 3);

  result.sections.push({
    pipeline: 'keyword',
    latestCron: mapHeaderSummary(headers[0]),
    recentCrons: headers.slice(0, 5).map(mapHeaderSummary),
    logs: mapLogRows(logs),
    failures: mapLogRows(failures),
    counts: summarizeCounts(logs),
    adCopyStatus: adHeaders.slice(0, 3).map((h) => ({
      cronId: h.ID,
      runningStatus: label(CRON_RUNNING, h.iCronRunningStatus),
      copyComplete: h.iCronCompleteCopyStatus,
      fullyDone: Number(h.iCronRunningStatus) === 2 && Number(h.iCronCompleteCopyStatus) === 1,
      end: h.dtCronEndDate,
    })),
  });

  return result;
}

async function reportSqp(pool, seller, job) {
  const { SQP_PULL_STATUS, SQP_CRON_RUNNING, label: lbl, LOG_STATUS: LS } = require('./status');
  const result = { service: 'sqp', sections: [] };

  if (!(await tableExists(pool, 'sqp_cron_details'))) {
    result.sections.push({ pipeline: 'sqp', note: 'sqp_cron_details table not found in this DB' });
    return result;
  }

  const headers = await fetchHeader(pool, 'sqp_cron_details', seller, 10);
  const latest = headers[0] || null;

  let reportType = null;
  const j = String(job.jobName || '').toUpperCase();
  if (['WEEK', 'WEEKLYSQP'].includes(j) || /week/i.test(job.jobName || '')) reportType = 'WEEK';
  if (['MONTH', 'MONTHLYSQP'].includes(j) || /month/i.test(job.jobName || '')) reportType = 'MONTH';
  if (['QUARTER', 'QUARTERLYSQP'].includes(j) || /quarter/i.test(job.jobName || '')) reportType = 'QUARTER';
  if (job.mode === 'all') reportType = null;

  let logs = [];
  if (latest && (await tableExists(pool, 'sqp_cron_logs'))) {
    let sql = `SELECT * FROM sqp_cron_logs WHERE CronJobID = :cronId`;
    const params = { cronId: latest.ID };
    if (reportType) {
      sql += ' AND ReportType = :reportType';
      params.reportType = reportType;
    }
    sql += ' ORDER BY ID DESC LIMIT 100';
    logs = await query(pool, sql, params);
  }

  let downloads = [];
  if (latest && (await tableExists(pool, 'sqp_download_urls'))) {
    downloads = await query(
      pool,
      `SELECT ID, CronJobID, Status, ProcessStatus, ErrorMessage, LastProcessError, dtUpdatedOn
       FROM sqp_download_urls WHERE CronJobID = :cronId
       ORDER BY ID DESC LIMIT 50`,
      { cronId: latest.ID }
    );
  }

  const pullSummary = latest
    ? {
        weekly: {
          status: lbl(SQP_PULL_STATUS, latest.WeeklySQPDataPullStatus),
          start: latest.WeeklySQPDataPullStartDate,
          end: latest.WeeklySQPDataPullEndDate,
        },
        monthly: {
          status: lbl(SQP_PULL_STATUS, latest.MonthlySQPDataPullStatus),
          start: latest.MonthlySQPDataPullStartDate,
          end: latest.MonthlySQPDataPullEndDate,
        },
        quarterly: {
          status: lbl(SQP_PULL_STATUS, latest.QuarterlySQPDataPullStatus),
          start: latest.QuarterlySQPDataPullStartDate,
          end: latest.QuarterlySQPDataPullEndDate,
        },
        cronRunning: lbl(SQP_CRON_RUNNING, latest.cronRunningStatus),
      }
    : null;

  result.sections.push({
    pipeline: 'sqp',
    latestCron: latest
      ? {
          cronId: latest.ID,
          sellerId: latest.SellerID,
          amazonSellerID: latest.AmazonSellerID,
          sellerName: latest.SellerName,
          runningStatus: lbl(SQP_CRON_RUNNING, latest.cronRunningStatus),
          start: latest.dtCronStartDate,
          created: latest.dtCreatedOn,
        }
      : null,
    pullSummary,
    logs: logs.map((r) => ({
      id: r.ID,
      reportType: r.ReportType,
      action: r.Action,
      status: lbl(LS, r.Status),
      statusCode: r.Status,
      message: r.Message,
      retryCount: r.RetryCount,
      updated: r.dtUpdatedOn,
    })),
    downloads: downloads.map((d) => ({
      id: d.ID,
      status: d.Status,
      processStatus: d.ProcessStatus,
      error: d.ErrorMessage || d.LastProcessError,
      updated: d.dtUpdatedOn,
    })),
    counts: summarizeCounts(logs, 'Status'),
  });

  return result;
}

module.exports = {
  resolveSeller,
  reportSp,
  reportAd,
  reportBackend,
  reportSqp,
};
