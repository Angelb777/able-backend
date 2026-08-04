const NICKNAME_MIN_LENGTH = 3;
const NICKNAME_MAX_LENGTH = 20;

function cleanNickname(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeNickname(value) {
  return cleanNickname(value).toLocaleLowerCase('es-ES');
}

function validateNickname(value) {
  const nickname = cleanNickname(value);
  if (nickname.length < NICKNAME_MIN_LENGTH || nickname.length > NICKNAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `El nickname debe tener entre ${NICKNAME_MIN_LENGTH} y ${NICKNAME_MAX_LENGTH} caracteres`,
    };
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(nickname)) {
    return {
      ok: false,
      error: 'El nickname solo puede contener letras, números, guion y guion bajo',
    };
  }
  if (!/[\p{L}\p{N}]/u.test(nickname)) {
    return { ok: false, error: 'El nickname debe contener al menos una letra o un número' };
  }
  return { ok: true, nickname, normalizedNickname: normalizeNickname(nickname) };
}

module.exports = {
  NICKNAME_MIN_LENGTH,
  NICKNAME_MAX_LENGTH,
  cleanNickname,
  normalizeNickname,
  validateNickname,
};
