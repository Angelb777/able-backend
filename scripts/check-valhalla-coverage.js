require('dotenv').config();
const { createGroundRouteProvider } = require('../api/services/groundRouteProvider');
const provider = createGroundRouteProvider();
const samples = [
  ['Zaragoza', { lat: 41.656745, lng: -0.878594 }, { lat: 41.658002, lng: -0.876992 }],
  ['Barcelona', { lat: 41.3874, lng: 2.1686 }, { lat: 41.3894, lng: 2.1706 }],
  ['Las Palmas', { lat: 28.1248, lng: -15.4300 }, { lat: 28.1260, lng: -15.4310 }],
  ['Ciudad de Panama', { lat: 8.9824, lng: -79.5199 }, { lat: 8.9844, lng: -79.5190 }],
];
(async () => {
  if (!provider.configured) throw new Error('Configura VALHALLA_BASE_URL');
  for (const [city, from, to] of samples) {
    for (const mode of ['walking', 'driving']) {
      const points = await provider.getRoute(from, to, mode);
      console.log(`${city} ${mode}: ${points.length > 1 ? 'OK' : 'FAIL'} (${points.length} puntos)`);
      if (points.length < 2) process.exitCode = 1;
    }
  }
  provider.clear();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
