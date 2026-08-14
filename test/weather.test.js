const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const { createWeatherService } = require("../api/services/weatherService");
const { createWeatherRouter } = require("../api/routes/weather");

test("weather service protects the key and reuses its ten minute cache", async () => {
  let calls = 0;
  let requestedUrl;
  const payload = { current: { weather_code: 61, rain: 0.4 } };
  const weather = createWeatherService({
    endpoint: "https://customer-api.open-meteo.test/v1/forecast",
    apiKey: "server-secret",
    fetchImpl: async (url) => {
      calls++;
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => payload };
    },
  });

  assert.equal(await weather.getCurrent(41.65, -0.88), payload);
  assert.equal(await weather.getCurrent(41.651, -0.881), payload);
  assert.equal(calls, 1);
  assert.equal(requestedUrl.searchParams.get("apikey"), "server-secret");
});

test("weather route rejects invalid coordinates", async () => {
  const app = express();
  app.use("/api/weather", createWeatherRouter({
    weather: { getCurrent: async () => ({ current: {} }) },
  }));
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/weather/current?latitude=x&longitude=0`);
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});

