import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICING_MODELS,
  estimatePrepaidDelivery,
  mergePricingModelDetails,
} from './pricingModels';

test('mergePricingModelDetails merges API models and preserves all 6 billing codes', () => {
  const defaults = mergePricingModelDetails();
  assert.equal(defaults.length, 6);
  assert.deepEqual(
    defaults.map((m) => m.code),
    ['CPM', 'CPC', 'CPA', 'CPI', 'CPV', 'FIXED']
  );

  const fromApi = mergePricingModelDetails([
    { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.75 },
    { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.2 },
    { code: 'UNKNOWN', name: 'Ignored', unit: 'n/a', minUsd: 1 },
  ]);
  assert.equal(fromApi.length, 2);
  assert.equal(fromApi[0].minUsd, 0.75);
  assert.equal(fromApi[1].code, 'CPC');
});

test('estimatePrepaidDelivery calculates accurate impressions for CPM and event units for CPC/FIXED', () => {
  const models = mergePricingModelDetails(DEFAULT_PRICING_MODELS);
  const cpm = models.find((m) => m.code === 'CPM')!;
  const cpc = models.find((m) => m.code === 'CPC')!;
  const fixed = models.find((m) => m.code === 'FIXED')!;

  const cpmEst = estimatePrepaidDelivery(cpm, 100);
  assert.equal(cpmEst.meetsMinimum, true);
  assert.equal(cpmEst.estimatedUnits, 200_000);

  const cpcEst = estimatePrepaidDelivery(cpc, 50);
  assert.equal(cpcEst.meetsMinimum, true);
  assert.equal(cpcEst.estimatedUnits, 500);

  const fixedUnderMin = estimatePrepaidDelivery(fixed, 250);
  assert.equal(fixedUnderMin.meetsMinimum, false);
  assert.equal(fixedUnderMin.estimatedUnits, 0);

  const fixedMeetsMin = estimatePrepaidDelivery(fixed, 1000);
  assert.equal(fixedMeetsMin.meetsMinimum, true);
  assert.equal(fixedMeetsMin.estimatedUnits, 2);
});
