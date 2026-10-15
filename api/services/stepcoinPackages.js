const STEPCOIN_PACKAGES_EUR = new Map([
  [100, 1], [500, 4], [1000, 7], [2000, 12],
  [5000, 25], [10000, 45], [15000, 65], [20000, 80],
  [30000, 110], [40000, 130], [50000, 150], [60000, 180],
  [100000, 200],
]);

const MERCHANT_STEPCOIN_PACKAGES_EUR = new Map([
  [1500, 10],
  [15000, 65],
]);

const PLAY_PRODUCT_ID_BY_STEPCOINS = new Map([
  [100, 'stepcoins_100'], [500, 'stepcoins_500'],
  [1000, 'stepcoins_1000'], [1500, 'stepcoins_1500'],
  [2000, 'stepcoins_2000'], [5000, 'stepcoins_5000'],
  [10000, 'stepcoins_10000'], [15000, 'stepcoins_15000'],
  [20000, 'stepcoins_20000'], [30000, 'stepcoins_30000'],
  [40000, 'stepcoins_40000'], [50000, 'stepcoins_50000'],
  [60000, 'stepcoins_60000'], [100000, 'stepcoins_100000'],
]);

const STEPCOIN_AMOUNT_BY_PLAY_PRODUCT_ID = new Map(
  Array.from(PLAY_PRODUCT_ID_BY_STEPCOINS, ([stepcoins, id]) => [id, stepcoins]),
);

const STEPCOIN_AMOUNT_BY_APP_STORE_PRODUCT_ID = new Map([
  ['stepcoins_100', 100],
  ['stepcoins_500', 500],
  ['stepcoins_1000', 1000],
  ['stepcoins_2000', 2000],
  ['stepcoins_5000', 5000],
  ['stepcoins_10000', 10000],
  ['stepcoins_15000', 15000],
  ['stepcoins_20000', 20000],
  ['stepcoins_30000', 30000],
  ['stepcoins_40000', 40000],
  ['stepcoins_50000', 50000],
  ['stepcoins_100000', 100000],
]);

function stepcoinPackagesFor(role) {
  return role === 'comercio'
    ? MERCHANT_STEPCOIN_PACKAGES_EUR
    : STEPCOIN_PACKAGES_EUR;
}

module.exports = {
  PLAY_PRODUCT_ID_BY_STEPCOINS,
  STEPCOIN_AMOUNT_BY_APP_STORE_PRODUCT_ID,
  STEPCOIN_AMOUNT_BY_PLAY_PRODUCT_ID,
  stepcoinPackagesFor,
};
