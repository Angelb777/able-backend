function buildGoogleUserDocument({ privateName, email, uid, passwordHash }) {
  return {
    nombre: typeof privateName === 'string' ? privateName : '',
    email,
    password: passwordHash,
    role: 'cliente',
    googleId: uid,
  };
}

module.exports = { buildGoogleUserDocument };
