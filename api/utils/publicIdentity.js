function technicalAlias(userOrId) {
  const id = String(userOrId?._id || userOrId?.id || userOrId || '00000')
    .replace(/[^a-fA-F0-9]/g, '');
  const suffix = (id.slice(-5) || '00000').padStart(5, '0').toUpperCase();
  return `Jugador-${suffix}`;
}

function publicNickname(userOrId) {
  const nickname = typeof userOrId?.nickname === 'string' ? userOrId.nickname.trim() : '';
  return nickname || technicalAlias(userOrId);
}

function serializePublicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id || user.id || user),
    nickname: publicNickname(user),
    hasChosenNickname: Boolean(user.nickname),
    avatarUrl: user.fotoPerfil || '',
  };
}

module.exports = { technicalAlias, publicNickname, serializePublicUser };
