/** Status code dictionaries shared across services */

const CRON_RUNNING = {
  1: 'Active / Running',
  2: 'Complete',
  3: 'Ready For Retry',
  4: 'Running Retry',
  5: 'Retry Completed',
};

const ENTITY_STATUS = {
  1: 'Success',
  2: 'Partial Success',
  3: 'Complete Failure',
};

const LOG_STATUS = {
  1: 'Success',
  2: 'Failure',
  3: 'No Data / Retry Failed',
};

const SQP_PULL_STATUS = {
  0: 'Pending',
  1: 'Success',
  2: 'Failure',
  3: 'No Retry / Permanent Fail',
};

const SQP_PROCESS = {
  1: 'Request Report',
  2: 'Check Status',
  3: 'Download Report',
  4: 'Imported',
};

const SQP_CRON_RUNNING = {
  1: 'Running',
  2: 'Completed',
  3: 'Retry Marked',
  4: 'Retry Running',
  5: 'Retry Completed',
};

function label(map, value) {
  if (value === null || value === undefined || value === '') return null;
  const key = Number(value);
  return map[key] ?? `Unknown(${value})`;
}

function summarizeCounts(rows, statusField = 'iStatus') {
  const counts = { success: 0, failure: 0, other: 0, total: rows.length };
  for (const row of rows) {
    const s = Number(row[statusField]);
    if (s === 1) counts.success += 1;
    else if (s === 2) counts.failure += 1;
    else counts.other += 1;
  }
  return counts;
}

module.exports = {
  CRON_RUNNING,
  ENTITY_STATUS,
  LOG_STATUS,
  SQP_PULL_STATUS,
  SQP_PROCESS,
  SQP_CRON_RUNNING,
  label,
  summarizeCounts,
};
