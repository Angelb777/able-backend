const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('skin dashboard exposes the optional Bicycle action', () => {
  const dashboardJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
    'utf8'
  );
  const dashboardHtml = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard.html'),
    'utf8'
  );

  assert.match(
    dashboardJs,
    /\["cycling",\s*"Bicicleta \/ Bicycle",\s*true,\s*true\]/
  );
  assert.match(dashboardJs, /scripts\?\.bicicleta/);
  assert.match(dashboardHtml, /Run, Bicycle, Damage y GetUp son opcionales/);
});
