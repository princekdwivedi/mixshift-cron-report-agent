const { resolveJob, listAllJobs } = require('./job-catalog');
const { withConnection } = require('./db');
const { resolveSeller, reportSp, reportAd, reportBackend, reportSqp } = require('./reporters');

/**
 * Build a full success/failure cron summary.
 *
 * @param {object} input
 * @param {string} input.dbname - Tenant MySQL database name
 * @param {string|number} input.sellerId - seller.ID or AmazonSellerID
 * @param {string} input.cronJobName - reportType or service alias (sp-api, ad-api, backend, sqp, all, Campaigns, WEEK, ...)
 * @param {string} [input.service] - optional force: sp | ad | backend | sqp | all
 */
async function getCronReport({ dbname, sellerId, cronJobName, service }) {
  if (!dbname) throw new Error('dbname is required');
  if (!sellerId && sellerId !== 0) throw new Error('sellerId is required');
  if (!cronJobName) throw new Error('cronJobName is required');

  const job = resolveJob(cronJobName);
  if (service) {
    const s = String(service).toLowerCase();
    const map = { sp: 'sp', 'sp-api': 'sp', ad: 'ad', 'ad-api': 'ad', backend: 'backend', sqp: 'sqp', all: 'all' };
    if (map[s]) job.service = map[s];
  }

  return withConnection(dbname, async (pool) => {
    const seller = await resolveSeller(pool, sellerId);
    const services = [];

    const runSp = job.service === 'sp' || job.service === 'all';
    const runAd = job.service === 'ad' || job.service === 'all';
    const runBackend = job.service === 'backend' || job.service === 'all';
    const runSqp = job.service === 'sqp' || job.service === 'all';

    if (runSp) services.push(await reportSp(pool, seller, job));
    if (runAd) services.push(await reportAd(pool, seller, job));
    if (runBackend) services.push(await reportBackend(pool, seller, job));
    if (runSqp) services.push(await reportSqp(pool, seller, job));

    const summary = buildExecutiveSummary(services);

    return {
      ok: true,
      input: { dbname, sellerId: String(sellerId), cronJobName, resolved: job },
      seller,
      generatedAt: new Date().toISOString(),
      summary,
      services,
    };
  });
}

function buildExecutiveSummary(services) {
  let success = 0;
  let failure = 0;
  let other = 0;
  const highlights = [];

  for (const svc of services) {
    for (const section of svc.sections || []) {
      if (section.counts) {
        success += section.counts.success || 0;
        failure += section.counts.failure || 0;
        other += section.counts.other || 0;
      }
      if (section.latestCron) {
        highlights.push({
          service: svc.service,
          pipeline: section.pipeline,
          cronId: section.latestCron.cronId,
          runningStatus: section.latestCron.runningStatus,
          fullyDone: section.fullyDone,
          start: section.latestCron.start,
          end: section.latestCron.end,
        });
      }
      const failSample = (section.failures || []).slice(0, 3).map((f) => ({
        service: svc.service,
        pipeline: section.pipeline,
        reportType: f.reportType,
        message: f.message,
        end: f.end,
      }));
      highlights.push(...failSample.map((f) => ({ type: 'failure', ...f })));
    }
  }

  return {
    totals: { success, failure, other, total: success + failure + other },
    verdict:
      failure > 0 ? 'HAS_FAILURES' : success > 0 ? 'OK' : highlights.length ? 'NO_LOG_ROWS' : 'NO_DATA',
    highlights,
  };
}

module.exports = {
  getCronReport,
  listAllJobs,
  resolveJob,
};
