const d = require('./_401_sellers_jul16.json');
console.log('ALL|' + d.sellers.length);
for (const s of d.sellers) {
  console.log([s.dbname, s.sellerId, s.sellerName, s.amazonSellerId, s.lostAccessLabel, s.fail401Count].join('\t'));
}
console.log('---NEEDS_REVIEW---');
for (const s of d.sellers.filter(x => x.lostAccessLabel === 'No')) {
  console.log([s.dbname, s.sellerId, s.sellerName, s.amazonSellerId, s.fail401Count].join('\t'));
}
