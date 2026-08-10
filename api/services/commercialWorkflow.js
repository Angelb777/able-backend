const FIXED_PRICES = Object.freeze({
  commercial_skin: 500,
  'commercial_weapon:short': 250,
  'commercial_weapon:medium': 350,
  'commercial_weapon:long': 450,
});

const TERMINAL_STATUSES = new Set(['rejected', 'withdrawn', 'retired']);

function fixedPrice(type, subtype = '') {
  if (type === 'reward') return 0;
  const key = type === 'commercial_weapon' ? `${type}:${subtype}` : type;
  const price = FIXED_PRICES[key];
  if (price === undefined) throw new Error('Tipo o modalidad comercial no válida');
  return price;
}

function hasRequiredMaterial(request) {
  if (request.type === 'reward') return true;
  if (request.type === 'positioning') {
    return Boolean(request.formData?.logoUrl) || (request.materials?.length || 0) > 0;
  }
  return (request.materials?.length || 0) > 0;
}

function pendingStatus(request) {
  if (!['not_required', 'confirmed', 'waived'].includes(request.paymentStatus)) {
    return 'pending_payment';
  }
  return hasRequiredMaterial(request) ? 'pending_review' : 'pending_material';
}

function assertCanApprove(request) {
  if (TERMINAL_STATUSES.has(request.status)) throw new Error('La solicitud está cerrada');
  if (!['not_required', 'confirmed', 'waived'].includes(request.paymentStatus)) {
    throw new Error('El pago todavía no está confirmado');
  }
  if (!hasRequiredMaterial(request)) throw new Error('Falta material para revisar');
}

function addOneYear(date = new Date()) {
  const value = new Date(date);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value;
}

function recordTransition(request, {
  action, status, actorId, actorRole, notes = '', now = new Date(),
}) {
  const fromStatus = request.status;
  request.status = status;
  request.reviewNotes = notes;
  request.history ||= [];
  request.history.push({
    action, fromStatus, toStatus: status, actorId, actorRole, notes, at: now,
  });
  request.revision = (Number(request.revision) || 1) + 1;
}

module.exports = {
  FIXED_PRICES,
  fixedPrice,
  hasRequiredMaterial,
  pendingStatus,
  assertCanApprove,
  addOneYear,
  recordTransition,
};
