const { randomInt } = require('crypto');

const MINI_GAMES = Object.freeze({
  culture: Object.freeze({ id: 'culture', rouletteLabel: 'Juego de Cultura' }),
  space: Object.freeze({ id: 'space', rouletteLabel: 'Juego Nave Espacial' }),
  memory: Object.freeze({ id: 'memory', rouletteLabel: 'Memory Game' }),
  reflex: Object.freeze({ id: 'reflex', rouletteLabel: 'Reflex Game' }),
});
const MINI_GAME_IDS = Object.freeze(Object.keys(MINI_GAMES));
const LEGACY_LEVEL_REWARD_GAMES = Object.freeze(['culture', 'space']);

// Preserva el peso combinado original de minijuegos: 2.987 / 10.000.
const ROULETTE_OPTIONS = Object.freeze([
  ['Tirar otra vez', 3000], ['Nada', 2500],
  [MINI_GAMES.culture.rouletteLabel, 1200], ['Carta aleatoria', 1500],
  [MINI_GAMES.space.rouletteLabel, 600], [MINI_GAMES.memory.rouletteLabel, 600],
  [MINI_GAMES.reflex.rouletteLabel, 587],
  ['Gana 20000 Stepcoins', 5], ['Pierde 20000 Stepcoins', 8],
]);

const MEMORY_TIME_THRESHOLDS_MS = Object.freeze([
  7500, 9000, 11000, 14000, 17000, 21000, 26000, 32000, 40000,
]);
const REFLEX_REACTION_THRESHOLDS_MS = Object.freeze([
  170, 200, 230, 270, 320, 380, 460, 560, 700,
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
  const penalty = errors === 0 ? 0 : errors === 1 ? 1 : errors <= 3 ? 2 : errors <= 5 ? 3 : 4;
  return Math.max(1, timeScore - penalty);
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
