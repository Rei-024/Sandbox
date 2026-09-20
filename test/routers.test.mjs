import test from 'node:test';
import assert from 'node:assert/strict';
import { BRouterAdapter, GraphHopperAdapter, classifyBRouterMessage } from '../assets/js/routers.js';

const START = [13.6167, 47.6417];

/** Faengt die abgeschickte Anfrage ab und antwortet mit einer Minimalroute. */
function mockFetch(antwort) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body, method: options.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(antwort),
      json: async () => antwort,
    };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const GH_ANTWORT = {
  paths: [
    {
      distance: 42000,
      time: 3600000,
      ascend: 500,
      points: { coordinates: [[13.6, 47.6, 500], [13.7, 47.7, 600], [13.6, 47.6, 500]] },
    },
  ],
};

test('GraphHopper meidet Maut im Custom-Model', async () => {
  const { calls, restore } = mockFetch(GH_ANTWORT);
  try {
    const gh = new GraphHopperAdapter({ apiKey: 'test' });
    await gh.route([START, START], { curviness: 4, avoidToll: true });
    const model = JSON.parse(calls[0].body).custom_model;
    assert.ok(model.priority.some((r) => /toll/.test(r.if)), 'Maut-Regel fehlt');

    await gh.route([START, START], { curviness: 4, avoidToll: false });
    const ohne = JSON.parse(calls[1].body).custom_model;
    assert.ok(!ohne.priority.some((r) => /toll/.test(r.if)), 'abgeschaltet heißt abgeschaltet');
  } finally {
    restore();
  }
});

test('GraphHopper-Rundkurs schickt die richtigen Felder', async () => {
  const { calls, restore } = mockFetch(GH_ANTWORT);
  try {
    const gh = new GraphHopperAdapter({ apiKey: 'test' });
    const route = await gh.roundTrip(START, 95000, { seed: 7, curviness: 4 });
    const payload = JSON.parse(calls[0].body);

    assert.equal(payload.algorithm, 'round_trip');
    assert.equal(payload['round_trip.distance'], 95000);
    assert.equal(payload['round_trip.seed'], 7);
    assert.equal(payload['ch.disable'], true, 'Custom-Model braucht ch.disable');
    assert.deepEqual(payload.points, [[13.6167, 47.6417]], 'nur der Start');
    assert.equal(route.distanceM, 42000);
    assert.match(route.profileUsed, /round_trip/);
  } finally {
    restore();
  }
});

test('GraphHopper ohne Key erklaert sich, bevor er etwas schickt', async () => {
  const { calls, restore } = mockFetch(GH_ANTWORT);
  try {
    await assert.rejects(new GraphHopperAdapter({}).route([START, START]), /API-Key/);
    assert.equal(calls.length, 0, 'keine sinnlose Anfrage');
  } finally {
    restore();
  }
});

test('Die Dienste sagen ehrlich, was sie koennen', () => {
  const br = new BRouterAdapter().capabilities;
  const gh = new GraphHopperAdapter({ apiKey: 'x' }).capabilities;
  assert.equal(br.avoidToll, 'waypoints-only');
  assert.equal(br.roundTrip, false);
  assert.equal(gh.avoidToll, 'exact');
  assert.equal(gh.roundTrip, true);
});

test('BRouter waehlt das Profil nach der Kurvigkeit', () => {
  const auto = new BRouterAdapter({ profile: 'auto' });
  assert.equal(auto.resolveProfile(1), 'car-fast');
  assert.equal(auto.resolveProfile(5), 'car-eco');
  assert.equal(new BRouterAdapter({ profile: 'moped' }).resolveProfile(5), 'moped');
});

test('BRouter reicht Klartextfehler als Fehlerart weiter', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => 'target island detected for section 4',
  });
  try {
    const err = await new BRouterAdapter().route([START, START]).catch((e) => e);
    assert.equal(err.kind, 'unreachable');
    assert.equal(err.section, 4);
    assert.match(err.message, /abgeschnittenen Stück/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(classifyBRouterMessage('alles gut').kind, 'other');
});
