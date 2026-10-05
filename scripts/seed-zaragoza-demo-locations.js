require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../api/models/User');
const Establishment = require('../api/models/Establishment');
const PromocionComprada = require('../api/models/PromocionComprada');
const { saveImage } = require('../api/utils/mediaStorage');

const APPLY = process.argv.includes('--apply');
const OWNER_EMAIL = 'comercio@gmail.com';
const LABEL_DIRECTORY = path.join(__dirname, 'assets', 'zaragoza-demo-labels');
const DEMO_DURATION_MONTHS = 12;

const LOCATIONS = [
  {
    publicName: 'Cyclon · Scott Concept Store',
    address: 'C. Francisco Martínez Soria, 2, 50018 Zaragoza',
    lat: 41.6634397, lng: -0.8846047,
    label: 'cyclon-scott.png',
  },
  {
    publicName: 'Trek Bicycle Zaragoza',
    address: 'Av. Cesáreo Alierta, 135, 50013 Zaragoza',
    lat: 41.6354789, lng: -0.8642331,
    label: 'trek-zaragoza.png',
  },
  {
    publicName: 'Aragon Cycles, S.A.',
    address: 'Av. Navarra, 63, 50010 Zaragoza',
    lat: 41.65526, lng: -0.90689,
    label: 'aragon-cycles.png',
  },
  {
    publicName: 'Urban Bikes',
    address: 'C. Rioja, 24, 50017 Zaragoza',
    lat: 41.6542899, lng: -0.9095791,
    label: 'urban-bikes.png',
  },
  {
    publicName: 'Gran Vía Bikes',
    address: 'P.º Fernando el Católico, 53, 50006 Zaragoza',
    lat: 41.6391871, lng: -0.8962519,
    label: 'gran-via-bikes.png',
  },
  {
    publicName: 'Ciclería',
    address: 'C. Gavín, 6, 50001 Zaragoza',
    lat: 41.6534683, lng: -0.8739498,
    label: 'cicleria.png',
  },
  {
    publicName: 'Recicleta',
    address: 'C. Asalto, 69, 50002 Zaragoza',
    lat: 41.64975, lng: -0.87077,
    label: 'recicleta.png',
  },
  {
    publicName: 'BMK Zaragoza Store',
    address: 'Av. Casablanca, 18, 50019 Zaragoza',
    lat: 41.6200471, lng: -0.9289992,
    label: 'bmk-zaragoza.png',
  },
  {
    publicName: 'BICICLETAS ZARAGOZA',
    address: 'C. Pablo Ruiz Picasso, 4, 50018 Zaragoza',
    lat: 41.6733585, lng: -0.8849155,
    label: 'bicicletas-zaragoza.png',
  },
];

function addMonths(date, months) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

async function main() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) throw new Error('Falta MONGO_URI');
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });

  const owner = await User.findOne({
    email: { $regex: `^${OWNER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    role: 'comercio',
  }).select('_id email role').lean();
  if (!owner) throw new Error(`No existe una cuenta comercio con email ${OWNER_EMAIL}`);

  const audit = [];
  for (const item of LOCATIONS) {
    const existing = await Establishment.findOne({
      ownerId: owner._id,
      publicName: item.publicName,
      archived: { $ne: true },
    }).lean();
    const subscription = existing
      ? await PromocionComprada.findOne({ establishmentId: existing._id }).lean()
      : null;
    audit.push({
      owner: owner.email,
      publicName: item.publicName,
      establishment: existing ? 'exists' : 'create',
      publication: subscription ? 'preserve-existing' : 'create-courtesy',
      status: subscription?.status || '-',
      payment: subscription?.paymentStatus || '-',
      active: subscription?.activo ?? false,
      endsAt: subscription?.fechaFin?.toISOString?.() || '-',
      autoRenew: subscription?.autoRenew ?? false,
    });
  }

  console.table(audit);
  const unverifiedActivePublications = await PromocionComprada.countDocuments({
    activo: true,
    fechaFin: { $gte: new Date() },
    paymentStatus: { $nin: ['confirmed', 'waived', 'legacy_confirmed'] },
  });
  console.log(`Publicaciones activas sin pago verificable: ${unverifiedActivePublications}`);
  if (!APPLY) {
    console.log('Auditoría completada. Ejecuta con --apply para crear únicamente lo que falta.');
    return;
  }

  const now = new Date();
  const end = addMonths(now, DEMO_DURATION_MONTHS);
  let createdLocations = 0;
  let createdPublications = 0;

  for (const item of LOCATIONS) {
    let location = await Establishment.findOne({
      ownerId: owner._id,
      publicName: item.publicName,
      archived: { $ne: true },
    });

    if (!location) {
      const labelPath = path.join(LABEL_DIRECTORY, item.label);
      const buffer = fs.readFileSync(labelPath);
      const logoUrl = await saveImage({
        buffer,
        mimetype: 'image/png',
        originalname: item.label,
      }, 'commercial/establishments/demo-zaragoza');

      location = await Establishment.create({
        ownerId: owner._id,
        publicName: item.publicName,
        legalName: '',
        description: 'Comercio ciclista en Zaragoza.',
        address: item.address,
        city: 'Zaragoza',
        country: 'España',
        logoUrl,
        lat: item.lat,
        lng: item.lng,
        proximityMessage: `Descubre ${item.publicName}`.slice(0, 50),
        proximityRadiusMeters: 250,
        status: 'approved',
        approvedAt: now,
        archived: false,
      });
      createdLocations += 1;
    }

    const existingPublication = await PromocionComprada.findOne({
      establishmentId: location._id,
    });
    if (existingPublication) continue;

    await PromocionComprada.create({
      comercioId: owner._id,
      establishmentId: location._id,
      titulo: location.publicName,
      publicName: location.publicName,
      address: location.address,
      description: location.description,
      logoComercio: location.logoUrl,
      imagenBase: '/img/local.png',
      lat: location.lat,
      lng: location.lng,
      proximityMessage: location.proximityMessage,
      proximityRadiusMeters: 250,
      duracionMeses: DEMO_DURATION_MONTHS,
      precioStepcoins: 0,
      originalPriceStepcoins: 0,
      fechaInicio: now,
      fechaFin: end,
      activo: true,
      status: 'published',
      paymentStatus: 'waived',
      autoRenew: false,
      cancelAtPeriodEnd: false,
      promotionCode: 'DEMO_ZARAGOZA',
      checkoutReference: `DEMO-ZGZ-${location._id}`,
      approvedAt: now,
      publishedAt: now,
    });
    createdPublications += 1;
  }

  console.log(JSON.stringify({
    owner: OWNER_EMAIL,
    createdLocations,
    createdPublications,
    courtesyUntil: end.toISOString(),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
