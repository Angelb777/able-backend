const express = require('express');
const mongoose = require('mongoose');
const Clan = require('../models/Clan');
const User = require('../models/User');
const { verifyToken, requireNickname } = require('../middlewares/authMiddleware');
const { normalizeNickname } = require('../utils/nickname');
const { publicNickname, serializePublicUser } = require('../utils/publicIdentity');
const clanMembershipCache = require('../services/clanMembershipCache');
const notificationService = require('../services/notificationService');
const socialRealtime = require('../services/socialRealtime');

const router = express.Router();
router.use(verifyToken);
router.use(requireNickname);

const NAME_MIN = 3;
const NAME_MAX = 48;
const DESCRIPTION_MAX = 500;
const actionLimits = new Map();

function enforceActionLimit(key, limit = 30, windowMs = 60 * 1000) {
  const now = Date.now();
  let state = actionLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + windowMs };
  state.count += 1;
  actionLimits.set(key, state);
  if (state.count > limit) {
    throw Object.assign(new Error('Demasiadas acciones. Inténtalo de nuevo en unos segundos.'), { status: 429 });
  }
}

function cleanText(value, maxLength) {
  return String(value || '').normalize('NFKC').trim().slice(0, maxLength);
}

function validateClanInput(body, { partial = false } = {}) {
  const result = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, NAME_MAX);
    if (name.length < NAME_MIN) throw Object.assign(new Error(`El nombre debe tener al menos ${NAME_MIN} caracteres`), { status: 400 });
    result.name = name;
    result.normalizedName = name.toLocaleLowerCase('es-ES');
  }
  if (!partial || body.description !== undefined) {
    result.description = cleanText(body.description, DESCRIPTION_MAX);
  }
  if (!partial || body.imageUrl !== undefined) {
    const imageUrl = cleanText(body.imageUrl, 1000);
    if (imageUrl && !/^(https?:\/\/|\/uploads\/)/i.test(imageUrl)) {
      throw Object.assign(new Error('La URL de imagen no es válida'), { status: 400 });
    }
    result.imageUrl = imageUrl;
  }
  if (!partial || body.visibility !== undefined) {
    if (!['public', 'private'].includes(body.visibility)) {
      throw Object.assign(new Error('Visibilidad no válida'), { status: 400 });
    }
    result.visibility = body.visibility;
  }
  return result;
}

function isCreator(clan, userId) {
  return String(clan.creatorId?._id || clan.creatorId) === String(userId);
}

function isMember(clan, userId) {
  return clan.members.some((member) => String(member.userId?._id || member.userId) === String(userId));
}

function pendingForUser(items, userId) {
  return items.find((item) => item.status === 'pending' && String(item.userId?._id || item.userId) === String(userId));
}

function serializeClan(clan, viewerId, { detail = false } = {}) {
  const data = clan.toObject ? clan.toObject() : clan;
  const viewerIsCreator = isCreator(data, viewerId);
  const viewerIsMember = isMember(data, viewerId);
  const response = {
    id: String(data._id),
    name: data.name,
    description: data.description || '',
    imageUrl: data.imageUrl || '',
    visibility: data.visibility,
    status: data.status,
    creatorId: String(data.creatorId?._id || data.creatorId),
    creator: data.creatorId?._id ? serializePublicUser(data.creatorId) : null,
    memberCount: data.members?.length || 0,
    isCreator: viewerIsCreator,
    isMember: viewerIsMember,
    hasPendingInvitation: Boolean(pendingForUser(data.pendingInvitations || [], viewerId)),
    hasPendingJoinRequest: Boolean(pendingForUser(data.pendingJoinRequests || [], viewerId)),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
  if (detail) {
    response.members = (data.members || []).map((member) => ({
      user: serializePublicUser(member.userId),
      joinedAt: member.joinedAt,
    }));
    if (viewerIsCreator) {
      response.pendingInvitations = (data.pendingInvitations || [])
        .filter((item) => item.status === 'pending')
        .map((item) => ({ id: String(item._id), user: serializePublicUser(item.userId), createdAt: item.createdAt }));
      response.pendingJoinRequests = (data.pendingJoinRequests || [])
        .filter((item) => item.status === 'pending')
        .map((item) => ({ id: String(item._id), user: serializePublicUser(item.userId), createdAt: item.createdAt }));
    }
  }
  return response;
}

async function populatedClan(query) {
  return query
    .populate('creatorId', 'nickname fotoPerfil')
    .populate('members.userId', 'nickname fotoPerfil')
    .populate('pendingInvitations.userId', 'nickname fotoPerfil')
    .populate('pendingJoinRequests.userId', 'nickname fotoPerfil');
}

function notifyMembershipChanged(userIds, clanId, reason) {
  clanMembershipCache.invalidate(userIds);
  for (const userId of userIds.map(String)) {
    socialRealtime.emitToUser(userId, 'clan:membership-changed', { clanId: String(clanId), reason });
  }
}

router.post('/', async (req, res, next) => {
  try {
    const input = validateClanInput(req.body);
    const creatorId = req.user.id;
    const clan = await Clan.create({
      ...input,
      creatorId,
      members: [{ userId: creatorId, joinedAt: new Date() }],
    });

    let invitedUser = null;
    const inviteUserId = req.body.inviteUserId;
    if (inviteUserId) {
      if (!mongoose.isValidObjectId(inviteUserId) || String(inviteUserId) === String(creatorId)) {
        return res.status(201).json({ clan: serializeClan(clan, creatorId), invitationError: 'No se pudo invitar al usuario seleccionado' });
      }
      invitedUser = await User.findById(inviteUserId).select('nickname');
      if (invitedUser) {
        clan.pendingInvitations.push({ userId: inviteUserId, invitedByUserId: creatorId });
        await clan.save();
      }
    }
    notifyMembershipChanged([creatorId], clan._id, 'created');

    if (invitedUser) {
      const creator = await User.findById(creatorId).select('nickname').lean();
      await notificationService.createNotification({
        userId: invitedUser._id,
        type: 'clan_invitation',
        title: 'Invitación a clan',
        message: `${publicNickname(creator || creatorId)} te invita a unirte al clan ${clan.name}.`,
        data: { clanId: clan._id },
        dedupeKey: `clan-invite:${clan._id}:${invitedUser._id}:${clan.pendingInvitations.at(-1)._id}`,
      });
    }
    res.status(201).json({ clan: serializeClan(clan, creatorId), invited: Boolean(invitedUser) });
  } catch (error) {
    next(error);
  }
});

router.get('/overview', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const search = cleanText(req.query.search, 48).toLocaleLowerCase('es-ES');
    const [myClans, invitationClans, requestClans, publicClans] = await Promise.all([
      populatedClan(Clan.find({ status: 'active', 'members.userId': userId }).sort({ updatedAt: -1 })),
      populatedClan(Clan.find({ status: 'active', pendingInvitations: { $elemMatch: { userId, status: 'pending' } } }).sort({ updatedAt: -1 })),
      populatedClan(Clan.find({ pendingJoinRequests: { $elemMatch: { userId } } }).sort({ updatedAt: -1 })),
      populatedClan(Clan.find({
        status: 'active',
        visibility: 'public',
        ...(search ? { normalizedName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {}),
      }).sort({ memberCount: -1, updatedAt: -1 }).limit(100)),
    ]);

    const invitations = [];
    for (const clan of invitationClans) {
      const invitation = pendingForUser(clan.pendingInvitations, userId);
      if (invitation) invitations.push({ id: String(invitation._id), clan: serializeClan(clan, userId), createdAt: invitation.createdAt });
    }
    const requests = [];
    for (const clan of requestClans) {
      for (const request of clan.pendingJoinRequests.filter((item) => String(item.userId?._id || item.userId) === String(userId))) {
        requests.push({ id: String(request._id), clan: serializeClan(clan, userId), status: request.status, createdAt: request.createdAt, respondedAt: request.respondedAt });
      }
    }
    res.json({
      myClans: myClans.map((clan) => serializeClan(clan, userId)),
      invitations,
      requests,
      explore: publicClans.map((clan) => serializeClan(clan, userId)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/created/invitable', async (req, res, next) => {
  try {
    const targetUserId = req.query.targetUserId;
    if (!mongoose.isValidObjectId(targetUserId) || String(targetUserId) === String(req.user.id)) {
      return res.status(400).json({ error: 'Jugador objetivo no válido' });
    }
    const clans = await Clan.find({
      creatorId: req.user.id,
      status: 'active',
      members: { $not: { $elemMatch: { userId: targetUserId } } },
      pendingInvitations: { $not: { $elemMatch: { userId: targetUserId, status: 'pending' } } },
    }).sort({ updatedAt: -1 });
    res.json(clans.map((clan) => serializeClan(clan, req.user.id)));
  } catch (error) {
    next(error);
  }
});

router.get('/:clanId', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.clanId)) return res.status(404).json({ error: 'Clan no encontrado' });
    const clan = await populatedClan(Clan.findOne({ _id: req.params.clanId, status: 'active' }));
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (clan.visibility === 'private' && !isMember(clan, req.user.id) && !pendingForUser(clan.pendingInvitations, req.user.id)) {
      return res.status(403).json({ error: 'Este clan es privado' });
    }
    res.json(serializeClan(clan, req.user.id, { detail: true }));
  } catch (error) {
    next(error);
  }
});

router.put('/:clanId', async (req, res, next) => {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede editar el clan' });
    Object.assign(clan, validateClanInput(req.body, { partial: true }));
    await clan.save();
    res.json({ clan: serializeClan(clan, req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:clanId', async (req, res, next) => {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede eliminar el clan' });
    const memberIds = clan.members.map((member) => String(member.userId));
    clan.status = 'deleted';
    clan.deletedAt = new Date();
    for (const item of clan.pendingInvitations) if (item.status === 'pending') item.status = 'invalidated';
    for (const item of clan.pendingJoinRequests) if (item.status === 'pending') item.status = 'invalidated';
    await clan.save();
    notifyMembershipChanged(memberIds, clan._id, 'deleted');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:clanId/invitations', async (req, res, next) => {
  try {
    enforceActionLimit(`invite:${req.user.id}`, 30);
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede invitar' });
    let target = null;
    if (req.body.userId && mongoose.isValidObjectId(req.body.userId)) target = await User.findById(req.body.userId);
    if (!target && req.body.nickname) target = await User.findOne({ normalizedNickname: normalizeNickname(req.body.nickname) });
    if (!target) return res.status(404).json({ error: 'No existe ningún usuario con ese nickname' });
    if (String(target._id) === String(req.user.id)) return res.status(400).json({ error: 'No puedes invitarte a ti mismo' });
    if (isMember(clan, target._id)) return res.status(409).json({ error: 'El usuario ya pertenece al clan' });
    if (pendingForUser(clan.pendingInvitations, target._id)) return res.status(409).json({ error: 'Ya existe una invitación pendiente' });
    clan.pendingInvitations.push({ userId: target._id, invitedByUserId: req.user.id });
    await clan.save();
    const invitation = clan.pendingInvitations.at(-1);
    const actor = await User.findById(req.user.id).select('nickname').lean();
    await notificationService.createNotification({
      userId: target._id,
      type: 'clan_invitation',
      title: 'Invitación a clan',
      message: `${publicNickname(actor || req.user.id)} te invita a unirte al clan ${clan.name}.`,
      data: { clanId: clan._id, invitationId: invitation._id },
      dedupeKey: `clan-invite:${clan._id}:${target._id}:${invitation._id}`,
    });
    res.status(201).json({ invitationId: String(invitation._id) });
  } catch (error) {
    next(error);
  }
});

async function respondInvitation(req, res, next, action) {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    const invitation = clan.pendingInvitations.id(req.params.invitationId);
    if (!invitation || invitation.status !== 'pending') return res.status(409).json({ error: 'La invitación ya no está pendiente' });
    if (action === 'cancel') {
      if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede cancelar la invitación' });
      invitation.status = 'cancelled';
    } else {
      if (String(invitation.userId) !== String(req.user.id)) return res.status(403).json({ error: 'Esta invitación no te pertenece' });
      invitation.status = action === 'accept' ? 'accepted' : 'rejected';
      if (action === 'accept' && !isMember(clan, req.user.id)) clan.members.push({ userId: req.user.id, joinedAt: new Date() });
    }
    invitation.respondedAt = new Date();
    await clan.save();
    if (action === 'accept') notifyMembershipChanged([req.user.id], clan._id, 'joined');
    const actor = await User.findById(req.user.id).select('nickname').lean();
    if (action !== 'cancel') {
      await notificationService.createNotification({
        userId: clan.creatorId,
        type: `clan_invitation_${action}ed`,
        title: 'Invitación actualizada',
        message: `${publicNickname(actor || req.user.id)} ha ${action === 'accept' ? 'aceptado' : 'rechazado'} la invitación a ${clan.name}.`,
        data: { clanId: clan._id, invitationId: invitation._id },
        dedupeKey: `clan-invite-response:${invitation._id}:${action}`,
      });
    }
    res.json({ ok: true, joined: action === 'accept' });
  } catch (error) {
    next(error);
  }
}

router.post('/:clanId/invitations/:invitationId/accept', (req, res, next) => respondInvitation(req, res, next, 'accept'));
router.post('/:clanId/invitations/:invitationId/reject', (req, res, next) => respondInvitation(req, res, next, 'reject'));
router.post('/:clanId/invitations/:invitationId/cancel', (req, res, next) => respondInvitation(req, res, next, 'cancel'));

router.post('/:clanId/join-requests', async (req, res, next) => {
  try {
    enforceActionLimit(`join-request:${req.user.id}`, 30);
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (clan.visibility !== 'public') return res.status(403).json({ error: 'No puedes solicitar entrada a un clan privado' });
    if (isMember(clan, req.user.id)) return res.status(409).json({ error: 'Ya perteneces al clan' });
    if (pendingForUser(clan.pendingJoinRequests, req.user.id)) return res.status(409).json({ error: 'Ya existe una solicitud pendiente' });
    if (pendingForUser(clan.pendingInvitations, req.user.id)) return res.status(409).json({ error: 'Ya tienes una invitación pendiente para este clan' });
    clan.pendingJoinRequests.push({ userId: req.user.id });
    await clan.save();
    const request = clan.pendingJoinRequests.at(-1);
    const actor = await User.findById(req.user.id).select('nickname').lean();
    await notificationService.createNotification({
      userId: clan.creatorId,
      type: 'clan_join_request',
      title: 'Solicitud de entrada',
      message: `${publicNickname(actor || req.user.id)} solicita entrar en ${clan.name}.`,
      data: { clanId: clan._id, requestId: request._id },
      dedupeKey: `clan-request:${request._id}`,
    });
    res.status(201).json({ requestId: String(request._id) });
  } catch (error) {
    next(error);
  }
});

async function respondJoinRequest(req, res, next, action) {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    const request = clan.pendingJoinRequests.id(req.params.requestId);
    if (!request || request.status !== 'pending') return res.status(409).json({ error: 'La solicitud ya no está pendiente' });
    if (action === 'cancel') {
      if (String(request.userId) !== String(req.user.id)) return res.status(403).json({ error: 'Esta solicitud no te pertenece' });
      request.status = 'cancelled';
    } else {
      if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede gestionar solicitudes' });
      request.status = action === 'accept' ? 'accepted' : 'rejected';
      if (action === 'accept' && !isMember(clan, request.userId)) clan.members.push({ userId: request.userId, joinedAt: new Date() });
    }
    request.respondedAt = new Date();
    await clan.save();
    const requesterId = String(request.userId);
    if (action === 'accept') notifyMembershipChanged([requesterId], clan._id, 'joined');
    if (action !== 'cancel') {
      await notificationService.createNotification({
        userId: requesterId,
        type: `clan_join_request_${action}ed`,
        title: 'Solicitud actualizada',
        message: `Tu solicitud para ${clan.name} ha sido ${action === 'accept' ? 'aceptada' : 'rechazada'}.`,
        data: { clanId: clan._id, requestId: request._id },
        dedupeKey: `clan-request-response:${request._id}:${action}`,
      });
    }
    res.json({ ok: true, joined: action === 'accept' });
  } catch (error) {
    next(error);
  }
}

router.post('/:clanId/join-requests/:requestId/accept', (req, res, next) => respondJoinRequest(req, res, next, 'accept'));
router.post('/:clanId/join-requests/:requestId/reject', (req, res, next) => respondJoinRequest(req, res, next, 'reject'));
router.post('/:clanId/join-requests/:requestId/cancel', (req, res, next) => respondJoinRequest(req, res, next, 'cancel'));

router.post('/:clanId/leave', async (req, res, next) => {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (isCreator(clan, req.user.id)) return res.status(409).json({ error: 'El creador debe eliminar el clan; no puede abandonarlo' });
    if (!isMember(clan, req.user.id)) return res.status(409).json({ error: 'No perteneces al clan' });
    clan.members = clan.members.filter((member) => String(member.userId) !== String(req.user.id));
    await clan.save();
    notifyMembershipChanged([req.user.id], clan._id, 'left');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/:clanId/members/:userId', async (req, res, next) => {
  try {
    const clan = await Clan.findOne({ _id: req.params.clanId, status: 'active' });
    if (!clan) return res.status(404).json({ error: 'Clan no encontrado' });
    if (!isCreator(clan, req.user.id)) return res.status(403).json({ error: 'Solo el creador puede expulsar miembros' });
    if (String(req.params.userId) === String(clan.creatorId)) return res.status(400).json({ error: 'No puedes expulsar al creador' });
    if (!isMember(clan, req.params.userId)) return res.status(404).json({ error: 'El usuario no pertenece al clan' });
    clan.members = clan.members.filter((member) => String(member.userId) !== String(req.params.userId));
    await clan.save();
    notifyMembershipChanged([req.params.userId], clan._id, 'expelled');
    await notificationService.createNotification({
      userId: req.params.userId,
      type: 'clan_expulsion',
      title: 'Expulsión de clan',
      message: `Has sido expulsado del clan ${clan.name}.`,
      data: { clanId: clan._id },
      dedupeKey: `clan-expulsion:${clan._id}:${req.params.userId}:${Date.now()}`,
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  console.error('[CLANS]', error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Error interno al gestionar el clan' });
});

module.exports = router;
