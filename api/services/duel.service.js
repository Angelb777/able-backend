const crypto = require('crypto');

const RANKS = Object.freeze([
  { wins: 600, name: 'Negro', color: '#111111' },
  { wins: 400, name: 'Marrón', color: '#795548' },
  { wins: 250, name: 'Morado', color: '#8E44AD' },
  { wins: 160, name: 'Azul', color: '#2980B9' },
  { wins: 100, name: 'Verde', color: '#27AE60' },
  { wins: 60, name: 'Naranja', color: '#F39C12' },
  { wins: 30, name: 'Amarillo', color: '#F1C40F' },
  { wins: 10, name: 'Blanco', color: '#FFFFFF' },
]);

const CULTURE_QUESTIONS = Object.freeze([
  ['¿Cuál es la capital de Francia?', ['Berlín', 'Madrid', 'París'], 2],
  ['¿Quién escribió Don Quijote?', ['Miguel de Cervantes', 'William Shakespeare', 'Homero'], 0],
  ['¿Qué planeta es conocido como el planeta rojo?', ['Marte', 'Júpiter', 'Venus'], 0],
  ['¿Cuál es el océano más grande?', ['Atlántico', 'Índico', 'Pacífico'], 2],
  ['¿Cuál es el símbolo químico del agua?', ['O2', 'H2O', 'CO2'], 1],
  ['¿En qué año llegó el ser humano a la Luna?', ['1969', '1970', '1965'], 0],
  ['¿Cuántas patas tiene una araña?', ['6', '8', '10'], 1],
  ['¿Cuál es la capital de Italia?', ['Roma', 'Milán', 'Venecia'], 0],
  ['¿Qué instrumento mide la presión atmosférica?', ['Barómetro', 'Termómetro', 'Higrómetro'], 0],
  ['¿Cuál es el país más grande por superficie?', ['China', 'Rusia', 'Canadá'], 1],
  ['¿Qué gas es esencial para la respiración humana?', ['CO2', 'Oxígeno', 'Hidrógeno'], 1],
  ['¿Cuál es la capital de Australia?', ['Sídney', 'Canberra', 'Melbourne'], 1],
  ['¿Quién propuso la teoría de la relatividad?', ['Isaac Newton', 'Albert Einstein', 'Galileo Galilei'], 1],
  ['¿Qué elemento tiene el símbolo Na?', ['Nitrógeno', 'Sodio', 'Neón'], 1],
  ['¿Qué tipo de animal es un delfín?', ['Pez', 'Mamífero', 'Reptil'], 1],
  ['¿Cuánto es 8 × 7?', ['56', '54', '49'], 0],
  ['¿Cuál es el hueso más largo del cuerpo humano?', ['Fémur', 'Húmero', 'Tibia'], 0],
  ['¿Quién descubrió la penicilina?', ['Louis Pasteur', 'Alexander Fleming', 'Marie Curie'], 1],
  ['¿Qué instrumento tiene normalmente 88 teclas?', ['Piano', 'Guitarra', 'Violín'], 0],
  ['¿Cuál es la unidad de frecuencia?', ['Pascal', 'Hertz', 'Newton'], 1],
  ['¿Cuántos planetas hay en el sistema solar?', ['8', '9', '7'], 0],
  ['¿Qué órgano bombea la sangre?', ['Pulmones', 'Corazón', 'Estómago'], 1],
  ['¿Cuál es el símbolo químico del oro?', ['Ag', 'Au', 'Pb'], 1],
  ['¿En qué año se disolvió la URSS?', ['1991', '1989', '1993'], 0],
  ['¿Cuál es la capital de Canadá?', ['Toronto', 'Vancouver', 'Ottawa'], 2],
  ['¿Quién escribió Hamlet?', ['Charles Dickens', 'William Shakespeare', 'Mark Twain'], 1],
  ['¿Cuál es el punto más alto de la Tierra?', ['Everest', 'K2', 'Kilimanjaro'], 0],
  ['¿En qué ciudad está el Coliseo?', ['Roma', 'Atenas', 'Estambul'], 0],
  ['¿Cuál es el idioma oficial de Brasil?', ['Español', 'Portugués', 'Francés'], 1],
  ['¿Cuál es la unidad de resistencia eléctrica?', ['Ohmio', 'Voltio', 'Amperio'], 0],
]);

function publicDuelStats(raw = {}) {
  const wins = Math.max(0, Number(raw.wins) || 0);
  const losses = Math.max(0, Number(raw.losses) || 0);
  const played = wins + losses;
  const rank = played === 0 ? null : RANKS.find((entry) => wins >= entry.wins) || null;
  const next = [...RANKS].reverse().find((entry) => wins < entry.wins) || null;
  return {
    wins,
    losses,
    played,
    rank: rank ? { name: rank.name, color: rank.color, wins: rank.wins } : null,
    winsToNextRank: next ? next.wins - wins : 0,
    nextRank: next ? { name: next.name, color: next.color, wins: next.wins } : null,
  };
}

function shuffledCultureQuestions(random = Math.random) {
  const entries = CULTURE_QUESTIONS.map((entry, index) => ({ entry, index }));
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries.map(({ entry, index }) => ({
    id: `culture-${index}`,
    question: entry[0],
    options: [...entry[1]],
    correctIndex: entry[2],
  }));
}

function newDuelId(prefix = 'duel') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = { RANKS, publicDuelStats, shuffledCultureQuestions, newDuelId };
