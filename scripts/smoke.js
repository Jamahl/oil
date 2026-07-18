'use strict';
// CLI smoke test: fetch data, build features, run the ridge walk-forward, print metrics.
const { yahooDaily, eiaCrudeStocks } = require('../lib/fetchers');
const { buildDataset } = require('../lib/data');
const { fitFnFor, walkForward, evaluate, calibrateBuckets } = require('../lib/model');

(async () => {
  const [brent, wti, dxy, ovx, inv] = await Promise.all([
    yahooDaily('BZ=F'),
    yahooDaily('CL=F'),
    yahooDaily('DX-Y.NYB'),
    yahooDaily('^OVX').catch((e) => (console.warn('OVX failed:', e.message), null)),
    eiaCrudeStocks().catch((e) => (console.warn('EIA failed:', e.message), null)),
  ]);
  console.log('brent bars:', brent.dates.length, brent.dates[0], '->', brent.dates[brent.dates.length - 1]);
  console.log('wti bars:', wti.dates.length, '| dxy:', dxy.dates.length, '| ovx:', ovx ? ovx.dates.length : 'MISSING', '| eia weeks:', inv ? inv.weekEnd.length : 'MISSING');

  const ds = buildDataset({ brent, wti, dxy, ovx, inv });
  console.log('usable rows:', ds.rows.length, ds.rows[0].date, '->', ds.rows[ds.rows.length - 1].date);
  console.log('features:', ds.features.map((f) => f.key).join(', '));

  for (const horizon of ['fwd1', 'fwd5']) {
    const t0 = Date.now();
    const preds = walkForward(ds.rows, horizon, fitFnFor('ridge'), { initialFrac: 0.6, step: 21 });
    const bt = evaluate(ds.rows, preds, horizon, horizon === 'fwd5' ? 5 : 1);
    const calib = calibrateBuckets(ds.rows, preds, horizon);
    console.log(`\n[ridge ${horizon}] ${Date.now() - t0}ms  OOS ${bt.oosStart} -> ${bt.oosEnd}`);
    console.log(`  n=${bt.n} hit=${(bt.hitRate * 100).toFixed(1)}% baseUp=${(bt.baseRateUp * 100).toFixed(1)}% IC=${bt.ic.toFixed(3)}`);
    console.log(`  MAE=${(bt.mae * 100).toFixed(2)}% naive=${(bt.maeNaive * 100).toFixed(2)}% sharpe(no costs)=${bt.sharpeNoCosts.toFixed(2)} maxDD=${(bt.maxDrawdown * 100).toFixed(1)}%`);
    if (calib) {
      for (const [name, b] of Object.entries(calib.buckets)) {
        console.log(`  ${name}: n=${b.n} hit=${b.n ? ((b.hits / b.n) * 100).toFixed(1) : '-'}%`);
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
