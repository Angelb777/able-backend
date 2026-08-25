function unownedCards(cards, ownedCardIds) {
  const owned = new Set((ownedCardIds || []).map((id) => String(id)));
  return cards.filter((card) => !owned.has(String(card._id)));
}

function pickRandomCard(cards, random = Math.random) {
  if (!cards.length) return null;
  return cards[Math.floor(random() * cards.length)];
}

async function findRandomUnownedCard(CardModel, ownedCardIds, random = Math.random) {
  const cards = await CardModel.find().select('_id titulo imagenPortada');
  return pickRandomCard(unownedCards(cards, ownedCardIds), random);
}

function publicCard(card) {
  if (!card) return null;
  return {
    _id: String(card._id),
    titulo: card.titulo,
    imagenPortada: card.imagenPortada || null,
  };
}

module.exports = { findRandomUnownedCard, publicCard, unownedCards, pickRandomCard };
