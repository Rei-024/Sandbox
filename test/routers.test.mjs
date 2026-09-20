import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRouterAdapter,
  GraphHopperAdapter,
  OpenRouteServiceAdapter,
  classifyBRouterMessage,
} from '../assets/js/routers.js';

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

/* ---------------------------------------------------- Tarifgrenzen */

test('GraphHopper schaltet den flexiblen Modus ab, wenn der Tarif ihn ablehnt', async () => {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ message: 'Free packages cannot use flexible mode' }),
      };
    }
    return { ok: true, status: 200, json: async () => GH_ANTWORT };
  };
  try {
    const gh = new GraphHopperAdapter({ apiKey: 'test' });
    const route = await gh.route([START, START], { curviness: 4 });

    assert.ok(bodies[0]['ch.disable'], 'erster Versuch mit flexiblem Modus');
    assert.equal(bodies[1]['ch.disable'], undefined, 'zweiter ohne');
    assert.equal(bodies[1].custom_model, undefined);
    assert.equal(route.distanceM, 42000, 'die Route kommt trotzdem');
    assert.equal(gh.flexible, false);
    assert.equal(gh.capabilities.roundTrip, false);
    assert.equal(gh.capabilities.avoidToll, 'no');
    assert.ok(gh.notices[0].includes('flexiblen Modus'), 'der Nutzer erfährt davon');
  } finally {
    globalThis.fetch = original;
  }
});

test('GraphHopper lernt die Punktgrenze aus der Fehlermeldung', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ message: 'Too many points for Routing API: 10, allowed: 5' }),
  });
  try {
    const gh = new GraphHopperAdapter({ apiKey: 'test' });
    const err = await gh.route([START, START]).catch((e) => e);
    assert.equal(err.kind, 'too-many-points');
    assert.equal(err.maxPoints, 5);
    assert.equal(gh.capabilities.maxPoints, 5, 'und merkt sie sich');
  } finally {
    globalThis.fetch = original;
  }
});

/* ----------------------------------------------- OpenRouteService */

const ORS_ANTWORT = {
  features: [
    {
      properties: { summary: { distance: 98000, duration: 7200 }, ascent: 1200, descent: 1190 },
      geometry: {
        coordinates: [[13.6, 47.6, 500], [13.7, 47.7, 900], [13.6, 47.6, 500]],
      },
    },
  ],
};

test('OpenRouteService meidet Autobahn, Maut und Fähren', async () => {
  const { calls, restore } = mockFetch(ORS_ANTWORT);
  try {
    const ors = new OpenRouteServiceAdapter({ apiKey: 'test' });
    const route = await ors.route([START, START], { avoidMotorway: true, avoidToll: true });
    const body = JSON.parse(calls[0].body);

    assert.deepEqual(body.options.avoid_features, ['highways', 'tollways', 'ferries']);
    assert.equal(body.elevation, true, 'ohne Höhen kein Höhenprofil');
    assert.match(calls[0].url, /driving-car\/geojson$/);
    assert.equal(route.distanceM, 98000);
    assert.equal(route.routerTimeS, 7200);
    assert.equal(route.ascentM, 1200);
    assert.equal(route.coords.length, 3);
  } finally {
    restore();
  }
});

test('OpenRouteService schickt den Key im Kopf, nicht in der URL', async () => {
  const original = globalThis.fetch;
  let kopf = null;
  globalThis.fetch = async (url, options = {}) => {
    kopf = options.headers;
    assert.ok(!String(url).includes('geheim'), 'Key gehört nicht in die URL');
    return { ok: true, status: 200, json: async () => ORS_ANTWORT };
  };
  try {
    await new OpenRouteServiceAdapter({ apiKey: 'geheim' }).route([START, START]);
    assert.equal(kopf.Authorization, 'geheim');
  } finally {
    globalThis.fetch = original;
  }
});

test('OpenRouteService-Rundkurs fragt nur einmal nach, wenn er abgelehnt wird', async () => {
  const original = globalThis.fetch;
  let anfragen = 0;
  globalThis.fetch = async () => {
    anfragen++;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'unsupported' } }) };
  };
  try {
    const ors = new OpenRouteServiceAdapter({ apiKey: 'test' });
    assert.equal(ors.capabilities.roundTrip, true);
    await ors.roundTrip(START, 90000, { seed: 1 }).catch(() => {});
    assert.equal(ors.capabilities.roundTrip, false, 'abgelehnt heißt: nicht nochmal versuchen');
    await ors.roundTrip(START, 90000, { seed: 2 }).catch(() => {});
    assert.equal(anfragen, 1, 'kein zweiter Anlauf, der nur Credits kostet');
  } finally {
    globalThis.fetch = original;
  }
});

test('createRouter liefert den eingestellten Dienst', async () => {
  const { createRouter } = await import('../assets/js/routers.js');
  assert.equal(createRouter({ provider: 'brouter' }).provider, 'brouter');
  assert.equal(createRouter({ provider: 'openrouteservice', orsKey: 'k' }).provider, 'openrouteservice');
  assert.equal(createRouter({ provider: 'graphhopper', graphhopperKey: 'k' }).provider, 'graphhopper');
});
