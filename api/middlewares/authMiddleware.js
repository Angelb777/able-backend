// api/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  // acepta "Bearer <token>" o el token “pelado”
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // normaliza el ID del usuario que vendrá dentro del token
    const id =
      decoded.id ||
      decoded._id ||
      decoded.sub ||
      (decoded.user && (decoded.user.id || decoded.user._id));

    if (!id) return res.status(401).json({ error: 'Token inválido (sin id)' });

    req.user = { ...decoded, id };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function checkRole(rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user || !rolesPermitidos.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
  };
}

function requireSelfOrAdmin(paramName = 'userId') {
  return (req, res, next) => {
    const requestedUserId = String(req.params?.[paramName] || '');
    const authenticatedUserId = String(req.user?.id || '');
    if (req.user?.role !== 'admin' && requestedUserId !== authenticatedUserId) {
      return res.status(403).json({ error: 'No puedes operar sobre otro usuario' });
    }
    next();
  };
}

async function requireNickname(req, res, next) {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('nickname').lean();
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (!user.nickname) {
      return res.status(428).json({
        error: 'Debes elegir un nickname antes de utilizar funciones sociales',
        code: 'NICKNAME_REQUIRED',
        needsNickname: true,
      });
    }
    req.publicUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { verifyToken, checkRole, requireSelfOrAdmin, requireNickname };
