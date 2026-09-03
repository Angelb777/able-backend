const { randomInt } = require('crypto');

const MINI_GAMES = Object.freeze({
  culture: Object.freeze({ id: 'culture', rouletteLabel: 'Juego de Cultura' }),
  space: Object.freeze({ id: 'space', rouletteLabel: 'Juego Nave Espacial' }),
  memory: Object.freeze({ id: 'memory', rouletteLabel: 'Memory Game' }),
  reflex: Object.freeze({ id: 'reflex', rouletteLabel: 'Reflex Game' }),
});
const MINI_GAME_IDS = Object.freeze(Object.keys(MINI_GAMES));
const LEGACY_LEVEL_REWARD_GAMES = Object.freeze(['culture', 'space']);

// Los cuatro minijuegos tienen exactamente la misma probabilidad. Se usan
// 40.000 puntos para conservar sin cambios el porcentaje de los demás premios.
const ROULETTE_OPTIONS = Object.freeze([
  ['Tirar otra vez', 12000], ['Nada', 10000],
  [MINI_GAMES.culture.rouletteLabel, 3287], ['Carta aleatoria', 4800],
  [MINI_GAMES.space.rouletteLabel, 3287], [MINI_GAMES.memory.rouletteLabel, 3287],
  [MINI_GAMES.reflex.rouletteLabel, 3287],
  ['Gana 20000 Stepcoins', 20], ['Pierde 20000 Stepcoins', 32],
]);

const MEMORY_TIME_THRESHOLDS_MS = Object.freeze([
  6500, 7500, 8500, 10000, 12000, 15000, 19000, 24000, 32000,
]);
const REFLEX_REACTION_THRESHOLDS_MS = Object.freeze([
  160, 185, 215, 250, 290, 340, 410, 500, 650,
]);
const REFLEX_LIGHT_COUNT = 5;
const REFLEX_LIGHT_INTERVAL_MS = 480;
const REFLEX_MIN_DELAY_MS = 900;
const REFLEX_MAX_DELAY_MS = 2400;

function chooseDuelGame(random = Math.random) {
  return MINI_GAME_IDS[Math.min(MINI_GAME_IDS.length - 1,
    Math.floor(random() * MINI_GAME_IDS.length))];
}
function reflexDelay() {
  return randomInt(REFLEX_MIN_DELAY_MS, REFLEX_MAX_DELAY_MS + 1);
}
function memoryScore(durationMs, errors) {
  const index = MEMORY_TIME_THRESHOLDS_MS.findIndex((limit) => durationMs <= limit);
  const timeScore = index < 0 ? 1 : 10 - index;
  const errorCap = errors === 0 ? 10 : errors === 1 ? 5 : errors === 2 ? 4 : errors === 3 ? 3 : 2;
  return Math.max(1, Math.min(timeScore, errorCap));
}
function reflexScore(reactionMs, falseStart = false) {
  if (falseStart) return 1;
  const index = REFLEX_REACTION_THRESHOLDS_MS.findIndex((limit) => reactionMs <= limit);
  return index < 0 ? 1 : 10 - index;
}

module.exports = {
  MINI_GAMES, MINI_GAME_IDS, LEGACY_LEVEL_REWARD_GAMES, ROULETTE_OPTIONS,
  MEMORY_TIME_THRESHOLDS_MS, REFLEX_REACTION_THRESHOLDS_MS,
  REFLEX_LIGHT_COUNT, REFLEX_LIGHT_INTERVAL_MS,
  chooseDuelGame, reflexDelay, memoryScore, reflexScore,
};
