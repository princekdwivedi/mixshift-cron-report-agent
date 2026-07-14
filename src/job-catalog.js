/**
 * Cron job catalog — maps friendly / reportType names to service tables.
 * Status codes are normalized in status.js
 */

const SP_SELLER_JOBS = [
  'ListMarketplaceParticipations',
  'GetMatchingProduct',
  'GetMatchingProductMetric',
  'GetProductCategoriesForASIN',
  'GetLowestPricedOffersForASIN',
  'getMerchantAllListingData',
  'getAfnInventoryByCountry',
  'getFbaFullfillmentCurrentInventory',
  'getFbaFullfillmentHealthInventory',
  'getFbaInventoryPlanning',
  'getFbaFullfillmentInventoryAdjustment',
  'getStrandedInventoryLoderData',
  'getFbaStorageData',
  'getInventorySummaries',
  'getFlatFileOrderReportData',
  'GetListOrders',
  'getSettlementReport',
  'getFbaFullfillmentCustomerReturnData',
  'getSalesTrafficSkuData',
  'analyticsReportByDate',
  'ListInboundShipmentsItems',
  'orderByDate',
];

const SP_VENDOR_JOBS = [
  'vendorItems',
  'vendorSalesSourcing',
  'vendorSalesManufacturing',
  'vendorTraffic',
  'vendorInventory',
  'vendorNetPureProductMargin',
];

const SP_CUSTOM_JOBS = ['catalogItemsStatus'];

const AD_JOBS = [
  'Portfolios',
  'Campaigns',
  'AdGroups',
  'Keywords',
  'ProductAd',
  'TargetExpressions',
  'ASIN',
  'ASIN_Target',
  'SponsoredBrandsCampaigns',
  'SponsoredBrandsAdGroups',
  'SponsoredBrandsKeywords',
  'SponsoredBrandsTargetExpressions',
  'SponsoredBrandsVideoCampaigns',
  'SponsoredBrandsVideoAdGroups',
  'SponsoredBrandsVideoKeywords',
  'SponsoredDisplayCampaigns',
  'SponsoredDisplayAdGroups',
  'SponsoredDisplayProductAd',
  'SponsoredDisplayTargetExpressions',
  'SponsoredTelevisionCampaigns',
  'SponsoredTelevisionAdGroups',
  'SponsoredTelevisionTargetExpressions',
];

const KEYWORD_BACKEND_JOBS = [
  'keywordSuggested',
  'keywordHarvesting',
];

const DSP_JOBS = [
  'DSPProducts',
  'DSPCampaigns',
  'DSPAdGroups',
  'DSPCreatives',
];

const SQP_JOBS = ['WEEK', 'MONTH', 'QUARTER', 'WeeklySQP', 'MonthlySQP', 'QuarterlySQP'];

/** Special aliases that mean "whole service pipeline" */
const SERVICE_ALIASES = {
  'sp-api': { service: 'sp', mode: 'all' },
  'spapi': { service: 'sp', mode: 'all' },
  'mws': { service: 'sp', mode: 'all' },
  'ad-api': { service: 'ad', mode: 'all' },
  'adapi': { service: 'ad', mode: 'all' },
  'advertising': { service: 'ad', mode: 'all' },
  'backend': { service: 'backend', mode: 'all' },
  'keyword': { service: 'backend', mode: 'keyword' },
  'sqp': { service: 'sqp', mode: 'all' },
  'all': { service: 'all', mode: 'all' },
};

function normalizeJobName(name) {
  return String(name || '').trim();
}

function resolveJob(cronJobName) {
  const raw = normalizeJobName(cronJobName);
  const lower = raw.toLowerCase();

  if (SERVICE_ALIASES[lower]) {
    return { ...SERVICE_ALIASES[lower], jobName: raw, kind: 'service' };
  }

  if (SP_SELLER_JOBS.includes(raw) || SP_SELLER_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = SP_SELLER_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'sp', mode: 'seller', jobName, kind: 'report' };
  }
  if (SP_VENDOR_JOBS.includes(raw) || SP_VENDOR_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = SP_VENDOR_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'sp', mode: 'vendor', jobName, kind: 'report' };
  }
  if (SP_CUSTOM_JOBS.includes(raw) || SP_CUSTOM_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = SP_CUSTOM_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'sp', mode: 'custom', jobName, kind: 'report' };
  }
  if (AD_JOBS.includes(raw) || AD_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = AD_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'ad', mode: 'ads', jobName, kind: 'report' };
  }
  if (DSP_JOBS.includes(raw) || DSP_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = DSP_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'ad', mode: 'dsp', jobName, kind: 'report' };
  }
  if (KEYWORD_BACKEND_JOBS.includes(raw) || KEYWORD_BACKEND_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = KEYWORD_BACKEND_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'backend', mode: 'keyword', jobName, kind: 'report' };
  }
  if (SQP_JOBS.includes(raw) || SQP_JOBS.some((j) => j.toLowerCase() === lower)) {
    const jobName = SQP_JOBS.find((j) => j.toLowerCase() === lower) || raw;
    return { service: 'sqp', mode: 'sqp', jobName, kind: 'report' };
  }

  // Unknown — try all services with the raw name as reportType
  return { service: 'all', mode: 'unknown', jobName: raw, kind: 'report' };
}

function listAllJobs() {
  return {
    'sp-api': { seller: SP_SELLER_JOBS, vendor: SP_VENDOR_JOBS, custom: SP_CUSTOM_JOBS },
    'ad-api': { ads: AD_JOBS, dsp: DSP_JOBS },
    backend: { keyword: KEYWORD_BACKEND_JOBS },
    sqp: SQP_JOBS,
    aliases: Object.keys(SERVICE_ALIASES),
  };
}

module.exports = {
  resolveJob,
  listAllJobs,
  SP_SELLER_JOBS,
  SP_VENDOR_JOBS,
  SP_CUSTOM_JOBS,
  AD_JOBS,
  DSP_JOBS,
  KEYWORD_BACKEND_JOBS,
  SQP_JOBS,
};
