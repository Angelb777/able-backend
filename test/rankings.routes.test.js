const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clanRankingPipeline,
  periodStart,
  rankingPeriod,
} = require('../api/routes/rankings');

test('ranking periods accept the supported values and default to all', () => {
  assert.equal(rankingPeriod('week'), 'week');
  assert.equal(rankingPeriod('month'), 'month');
  assert.equal(rankingPeriod('unknown'), 'all');
  assert.equal(periodStart('all', 1_000), null);
  assert.equal(periodStart('week', 7 * 86_400_000).getTime(), 0);
});

test('clan ranking counts only public active clans and mobility after joining', () => {
  const pipeline = clanRankingPipeline('month', Date.UTC(2026, 8, 3));
  assert.deepEqual(pipeline[0], {
    $match: { status: 'active', visibility: 'public' },
  });

  const conditions = pipeline[2].$lookup.pipeline[0].$match.$expr.$and;
  assert.ok(conditions.some((condition) =>
    condition.$gte?.[0] === '$fecha' && condition.$gte?.[1] === '$$joinedAt'));
  assert.ok(conditions.some((condition) => condition.$in?.[0] === '$metadata.source'));
  assert.ok(conditions.some((condition) => condition.$gte?.[1] instanceof Date));
  assert.deepEqual(pipeline.at(-2), { $sort: { mobilityStepcoins: -1, _id: 1 } });
  assert.deepEqual(pipeline.at(-1), { $limit: 100 });
});
