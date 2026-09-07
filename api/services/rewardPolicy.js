const MIN_COMMERCIAL_REWARD_STEPCOINS = 5000;

function assertCommercialRewardStepcoins(value) {
  const stepcoins = Number(value);
  if (!Number.isFinite(stepcoins) || stepcoins < MIN_COMMERCIAL_REWARD_STEPCOINS) {
    throw new Error(
      `El coste mínimo de un descuento o premio es de ${MIN_COMMERCIAL_REWARD_STEPCOINS} Stepcoins`
    );
  }
  return stepcoins;
}

module.exports = {
  MIN_COMMERCIAL_REWARD_STEPCOINS,
  assertCommercialRewardStepcoins,
};
