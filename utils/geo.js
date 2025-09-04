// utils/geo.js
const R = 6371000; // m

exports.distanceMeters = (a,b) => {
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
};

exports.computeOffset = (from, dist, headingDeg) => {
  const θ = headingDeg*Math.PI/180;
  const δ = dist/R;
  const φ1 = from.lat*Math.PI/180;
  const λ1 = from.lng*Math.PI/180;

  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));
  return { lat: φ2*180/Math.PI, lng: λ2*180/Math.PI };
};

// “Celda” por redondeo de coords a N decimales
exports.cellId = (lat, lng, decimals=3) => {
  const f = 10**decimals;
  return `${Math.round(lat*f)/f}_${Math.round(lng*f)/f}`;
};
