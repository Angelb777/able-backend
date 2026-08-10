/* eslint-disable no-console */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../api/models/User');
const Establishment = require('../api/models/Establishment');
const CommercialRequest = require('../api/models/CommercialRequest');
const PromocionComprada = require('../api/models/PromocionComprada');
const Reward = require('../api/models/Reward');

const apply = process.argv.includes('--apply');

async function run() {
  const uri = String(process.env.MONGO_URI || '').trim();
  if (!uri) throw new Error('Falta MONGO_URI');
  await mongoose.connect(uri);
  const commerces = await User.find({ role: 'comercio' }).lean();
  const positions = await PromocionComprada.find().lean();
  const rewards = await Reward.find({ comercioId: { $ne: null } }).lean();
  const positionByOwner = new Map();
  for (const item of positions) {
    if (!positionByOwner.has(String(item.comercioId))) {
      positionByOwner.set(String(item.comercioId), item);
    }
  }

  const report = {
    commerceUsers: commerces.length, establishmentsPrepared: 0,
    positioningRequestsPrepared: positions.length, rewardRequestsPrepared: rewards.length,
    skippedEstablishmentsWithoutCoordinates: 0, apply,
  };

  if (apply) {
    for (const commerce of commerces) {
      const position = positionByOwner.get(String(commerce._id));
      if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
        report.skippedEstablishmentsWithoutCoordinates++;
        continue;
      }
      await Establishment.updateOne(
        { ownerId: commerce._id },
        { $setOnInsert: {
          publicName: commerce.nombre || commerce.email,
          legalName: commerce.nombre || '', address: '',
          logoUrl: position.logoComercio || '', lat: position.lat, lng: position.lng,
          status: position.activo ? 'approved' : 'disabled',
          approvedAt: position.fechaInicio || position.createdAt,
        } },
        { upsert: true, runValidators: false }
      );
      report.establishmentsPrepared++;
    }

    for (const position of positions) {
      const request = await CommercialRequest.findOneAndUpdate(
        { legacySource: 'PromocionComprada', legacyId: position._id },
        { $setOnInsert: {
          ownerId: position.comercioId, type: 'positioning', subtype: '',
          title: position.titulo || 'Posicionamiento legacy',
          status: position.activo ? 'published' : 'disabled',
          price: Number(position.precioEuros) || 0, currency: 'EUR',
          paymentStatus: 'confirmed', paymentReference: 'legacy-import',
          paymentConfirmedAt: position.fechaInicio || position.createdAt,
          formData: {
            packageId: String(position.promoId), durationMonths: position.duracionMeses,
            packageTitle: position.titulo, baseImageUrl: position.imagenBase,
            logoUrl: position.logoComercio, lat: position.lat, lng: position.lng,
          },
          publishedAt: position.publishedAt || position.fechaInicio,
          targetModel: 'PromocionComprada', targetId: position._id,
          history: [{ action: 'legacy_import', toStatus: position.activo ? 'published' : 'disabled', actorRole: 'migration' }],
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await PromocionComprada.updateOne({ _id: position._id }, {
        $set: {
          commercialRequestId: request._id,
          status: position.activo ? 'published' : 'disabled',
          paymentStatus: 'legacy_confirmed',
        },
      });
    }

    for (const reward of rewards) {
      const status = reward.validado ? 'published' : 'pending_review';
      const request = await CommercialRequest.findOneAndUpdate(
        { legacySource: 'Reward', legacyId: reward._id },
        { $setOnInsert: {
          ownerId: reward.comercioId, type: 'reward',
          subtype: reward.tipo === 'premio' ? 'prize' : 'discount',
          title: reward.titulo || 'Reward legacy', status,
          price: 0, currency: 'EUR', paymentStatus: 'not_required',
          formData: {
            rewardType: reward.tipo, description: reward.descripcion,
            address: reward.direccion, percentage: reward.porcentaje,
            amountEuros: reward.cantidadEuros, stepcoins: reward.stepcoins,
          },
          targetModel: 'Reward', targetId: reward._id,
          publishedAt: reward.validado ? reward.fechaCreacion : undefined,
          history: [{ action: 'legacy_import', toStatus: status, actorRole: 'migration' }],
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await Reward.updateOne({ _id: reward._id }, {
        $set: {
          commercialRequestId: request._id,
          publicationStatus: reward.validado ? 'published' : 'pending',
        },
      });
    }
    await Promise.all([
      Establishment.createIndexes(),
      CommercialRequest.createIndexes(),
      PromocionComprada.createIndexes(),
      Reward.createIndexes(),
    ]);
  } else {
    report.establishmentsPrepared = commerces.filter((item) =>
      positionByOwner.has(String(item._id))).length;
    report.skippedEstablishmentsWithoutCoordinates =
      commerces.length - report.establishmentsPrepared;
  }
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
