import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverpassQuery,
  classPenaltyM,
  fetchRoadNetwork,
  networkCacheKey,
  parseOverpassRoads,
  snapWaypoints,
  TOLL_RADIUS_M,
  tollNogos,
  tollRoadsNear,
} from '../assets/js/roads.js';
import { destination, distance } from '../assets/js/geo.js';

const START = [13.6167, 47.6417]; // Bad Goisern

test('Overpass-Abfrage enthaelt Umkreis, Klassen und Obergrenze', () => {
  const q = buildOverpassQuery(START, 17000, 1500);
  assert.match(q, /^\[out:json\]\[timeout:25\];/);
  assert.match(q, /around:17000,47\.64170,13\.61670/);
  assert.match(q, /primary\|secondary\|tertiary\|unclassified\|residential/);
  assert.match(q, /access.*private\|no\|customers/);
  assert.match(q, /out tags center 1500;$/);
});

test('parseOverpassRoads nimmt nur brauchbare Eintraege', () => {
  const roads = parseOverpassRoads({
    elements: [
      { type: 'way', center: { lat: 47.6, lon: 13.6 }, tags: { highway: 'tertiary', name: 'Passstraße' } },
      { type: 'way', center: { lat: 47.7, lon: 13.7 }, tags: { highway: 'track' } }, // Feldweg
      { type: 'way', tags: { highway: 'secondary' } }, // ohne Koordinate
      { type: 'node', lat: 47.8, lon: 13.8, tags: { highway: 'primary' } },
    ],
  });
  assert.equal(roads.length, 2);
  assert.deepEqual(roads[0].point, [13.6, 47.6]);
  assert.equal(roads[0].name, 'Passstraße');
  assert.equal(roads[1].highway, 'primary');
  assert.deepEqual(parseOverpassRoads(null), []);
});

test('Klassenaufschlag folgt der Wunschkurvigkeit', () => {
  assert.ok(classPenaltyM('primary', 1) < classPenaltyM('unclassified', 1));
  assert.ok(classPenaltyM('unclassified', 5) < classPenaltyM('primary', 5));
  assert.ok(classPenaltyM('residential', 5) > classPenaltyM('tertiary', 5), 'Wohnstraßen bleiben unbeliebt');
});

test('snapWaypoints zieht auf die passende Strasse', () => {
  const wunsch = destination(START, 90, 12000);
  const roads = [
    { point: destination(wunsch, 0, 300), highway: 'residential' },
    { point: destination(wunsch, 0, 900), highway: 'tertiary' },
    { point: destination(wunsch, 0, 1500), highway: 'primary' },
  ];
  // Kurvig: die Nebenstrasse gewinnt trotz groesserem Abstand
  assert.deepEqual(snapWaypoints([wunsch], roads, { curviness: 5 })[0], roads[1].point);
  // Zuegig: die grosse Strasse ist den kurzen Umweg wert
  assert.deepEqual(snapWaypoints([wunsch], roads, { curviness: 1 })[0], roads[2].point);
});

test('Ein weiter Umweg fuer eine groessere Strasse lohnt nicht', () => {
  const wunsch = destination(START, 90, 12000);
  const roads = [
    { point: destination(wunsch, 0, 900), highway: 'tertiary' },
    { point: destination(wunsch, 0, 9000), highway: 'primary' },
  ];
  // Neun Kilometer daneben waeren keine Verbesserung, sondern eine andere Route.
  assert.deepEqual(snapWaypoints([wunsch], roads, { curviness: 1 })[0], roads[0].point);
});

test('Ist nichts in der Naehe, wird die naechstgelegene Strasse genommen', () => {
  // Den Wunschpunkt im Nirgendwo stehen zu lassen hiesse, den Router
  // sehenden Auges auf einen unerreichbaren Punkt zu schicken.
  const wunsch = destination(START, 90, 12000);
  const weit = [{ point: destination(wunsch, 0, 20000), highway: 'tertiary' }];
  assert.deepEqual(snapWaypoints([wunsch], weit, { maxSnapM: 6000 })[0], weit[0].point);
  assert.deepEqual(snapWaypoints([wunsch], [], {})[0], wunsch, 'ohne Daten bleibt alles wie es war');
});

test('Die Notfallwahl haelt sich trotzdem an Maut und Doppelbelegung', () => {
  const wunsch = destination(START, 90, 12000);
  const roads = [
    { point: destination(wunsch, 0, 20000), highway: 'tertiary', toll: true },
    { point: destination(wunsch, 0, 26000), highway: 'tertiary', toll: false },
  ];
  assert.deepEqual(
    snapWaypoints([wunsch], roads, { maxSnapM: 6000, avoidToll: true })[0],
    roads[1].point,
    'auch in der Not keine Mautstraße',
  );
});

test('snapWaypoints setzt nicht zwei Wegpunkte auf dieselbe Strasse', () => {
  const a = destination(START, 90, 12000);
  const b = destination(a, 90, 500);
  const einzige = [{ point: destination(a, 0, 100), highway: 'tertiary' }];
  const [erster, zweiter] = snapWaypoints([a, b], einzige, {});
  assert.deepEqual(erster, einzige[0].point);
  assert.deepEqual(zweiter, b, 'der zweite bleibt lieber liegen, als sich draufzusetzen');
});

test('fetchRoadNetwork weicht auf den zweiten Server aus', async () => {
  const original = globalThis.fetch;
  const angefragt = [];
  globalThis.fetch = async (url) => {
    angefragt.push(String(url));
    if (angefragt.length === 1) return { ok: false, status: 504 };
    return {
      ok: true,
      json: async () => ({
        elements: [{ type: 'way', center: { lat: 47.6, lon: 13.6 }, tags: { highway: 'tertiary' } }],
      }),
    };
  };
  try {
    const roads = await fetchRoadNetwork(START, 10000);
    assert.equal(roads.length, 1);
    assert.equal(angefragt.length, 2, 'erst der eine Server, dann der andere');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchRoadNetwork meldet sich, wenn kein Server antwortet', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Netz weg');
  };
  try {
    await assert.rejects(fetchRoadNetwork(START, 10000), /Netz weg/);
  } finally {
    globalThis.fetch = original;
  }
});

test('networkCacheKey greift bei kleinen Abweichungen noch', () => {
  const a = networkCacheKey(START, 17000);
  const b = networkCacheKey(destination(START, 45, 300), 17600);
  assert.equal(a, b, 'ein paar hundert Meter duerfen den Speicher nicht entwerten');
  assert.notEqual(a, networkCacheKey(START, 40000));
});

test('Mautstrassen werden beim Aufschnappen uebersprungen', () => {
  const wunsch = destination(START, 90, 12000);
  const roads = [
    { point: destination(wunsch, 0, 200), highway: 'tertiary', toll: true, name: 'Postalmstraße' },
    { point: destination(wunsch, 0, 2000), highway: 'tertiary', toll: false },
  ];
  assert.deepEqual(snapWaypoints([wunsch], roads, { avoidToll: true })[0], roads[1].point);
  assert.deepEqual(snapWaypoints([wunsch], roads, { avoidToll: false })[0], roads[0].point);
});

test('parseOverpassRoads merkt sich die Maut', () => {
  const [frei, maut] = parseOverpassRoads({
    elements: [
      { type: 'way', center: { lat: 47.6, lon: 13.6 }, tags: { highway: 'tertiary' } },
      {
        type: 'way',
        center: { lat: 47.7, lon: 13.7 },
        tags: { highway: 'tertiary', toll: 'yes', ref: 'L546' },
      },
    ],
  });
  assert.equal(frei.toll, false);
  assert.equal(maut.toll, true);
  assert.equal(maut.name, 'L546', 'ohne Namen tut es die Nummer');
});

test('tollRoadsNear meldet nur, was wirklich am Weg liegt', () => {
  const route = [];
  for (let i = 0; i <= 60; i++) route.push(destination(START, 90, i * 300));
  const roads = [
    { point: destination(START, 90, 9000), highway: 'tertiary', toll: true, name: 'Passstraße' },
    { point: destination(START, 270, 9000), highway: 'tertiary', toll: true, name: 'Andere Seite' },
    { point: destination(START, 90, 6000), highway: 'tertiary', toll: false, name: 'Gratis' },
  ];
  const treffer = tollRoadsNear(route, roads);
  assert.deepEqual(treffer, ['Passstraße']);
  assert.deepEqual(tollRoadsNear(route, []), []);
});

test('tollNogos liefert BRouter-Sperrzonen, die naechsten zuerst', () => {
  const roads = [
    { point: destination(START, 0, 30000), toll: true, highway: 'tertiary' },
    { point: destination(START, 0, 5000), toll: true, highway: 'tertiary' },
    { point: destination(START, 0, 8000), toll: false, highway: 'tertiary' },
  ];
  const zonen = tollNogos(roads, { keepClear: [START], radiusM: 250 });
  assert.equal(zonen.length, 2, 'nur Mautstraßen');
  assert.equal(zonen[0][2], 250);
  assert.ok(
    distance(START, [zonen[0][0], zonen[0][1]]) < distance(START, [zonen[1][0], zonen[1][1]]),
    'die naheliegenden zuerst',
  );
  assert.equal(tollNogos(roads, { keepClear: [START], limit: 1 }).length, 1, 'Deckel greift');
  assert.deepEqual(tollNogos([{ point: START, toll: false }]), []);
});

test('Sperrkreise bleiben klein und lassen den Start frei', () => {
  const roads = [
    { point: destination(START, 0, 400), toll: true, highway: 'tertiary', name: 'Zufahrt' },
    { point: destination(START, 0, 9000), toll: true, highway: 'tertiary', name: 'Passstraße' },
  ];
  const zonen = tollNogos(roads, { keepClear: [START] });

  assert.equal(zonen.length, 1, 'die Zufahrt am Start darf nicht zugemauert werden');
  assert.equal(zonen[0][2], 150, 'kleiner Radius: ein Sperrkreis trifft auch kreuzende Straßen');
});

test('Auch das Ziel einer Einwegstrecke bleibt von Sperrzonen frei', () => {
  const ziel = destination(START, 90, 40000);
  const roads = [
    { point: destination(ziel, 0, 500), toll: true, highway: 'tertiary', name: 'Zufahrt Ziel' },
    { point: destination(START, 0, 9000), toll: true, highway: 'tertiary', name: 'Passstraße' },
  ];
  const zonen = tollNogos(roads, { keepClear: [START, ziel] });
  assert.equal(zonen.length, 1, 'die Zufahrt zum Ziel darf nicht zugemauert werden');
});

test('Warnschwelle und Sperrradius sind derselbe Wert', () => {
  // Sonst kann die Route legal zwischen beiden liegen und genau den
  // Fehlalarm ausloesen, den die Sperre verhindern soll.
  const auf = [];
  for (let i = 0; i <= 40; i++) auf.push(destination(START, 90, i * 100));
  const knapp = { point: destination(auf[20], 0, TOLL_RADIUS_M + 40), toll: true, highway: 'tertiary', name: 'Knapp daneben' };
  assert.deepEqual(tollRoadsNear(auf, [knapp]), [], 'außerhalb des Sperrradius keine Warnung');
});
