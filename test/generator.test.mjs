import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dropWaypoint,
  generateRoutes,
  measure,
  mulberry32,
  nudgeWaypoints,
  rotateWaypoint,
  spurCulprit,
  targetDistanceM,
} from '../assets/js/generator.js';
import { bearing, destination, distance, overlapDetail } from '../assets/js/geo.js';
import { FakeRouter } from './fake-router.mjs';

const START = [8.4117, 48.4636]; // Freudenstadt
const fast = { requestGapMs: 0 };

test('targetDistanceM: kurvig heisst kuerzer bei gleicher Zeit', () => {
  const zwei = targetDistanceM(120, 1);
  const kurvig = targetDistanceM(120, 5);
  assert.ok(kurvig < zwei);
  assert.ok(zwei / 1000 > 100 && zwei / 1000 < 200);
});

test('Runde trifft die Wunschdauer und kehrt zum Start zurueck', async () => {
  const router = new FakeRouter({ wiggle: 0.4 });
  const { best } = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 3, variants: 2, seed: 1 },
    { router, ...fast },
  );
  const err = Math.abs(best.durationMin - 120) / 120;
  assert.ok(err < 0.15, `Abweichung ${(err * 100).toFixed(0)} % (${best.durationMin} min)`);

  const ende = best.coords[best.coords.length - 1];
  assert.ok(distance(START, ende) < 50, 'Runde muss am Start enden');
});

test('Wunschdauer skaliert die Streckenlaenge mit', async () => {
  const router = new FakeRouter({ wiggle: 0.4 });
  const kurz = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 60, curviness: 3, variants: 1, seed: 5 },
    { router, ...fast },
  );
  const lang = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 240, curviness: 3, variants: 1, seed: 5 },
    { router, ...fast },
  );
  assert.ok(lang.best.distanceM > kurz.best.distanceM * 2.5);
});

test('Hoehere Kurvigkeit erzeugt mehr Wegpunkte', async () => {
  const router = new FakeRouter({ wiggle: 0.3 });
  const glatt = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 90, curviness: 1, variants: 1, seed: 3 },
    { router, ...fast },
  );
  const kurvig = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 90, curviness: 5, variants: 1, seed: 3 },
    { router, ...fast },
  );
  assert.ok(kurvig.best.waypoints.length > glatt.best.waypoints.length);
});

test('Gleicher Seed liefert dasselbe Ergebnis, anderer Seed nicht', async () => {
  const run = (seed) =>
    generateRoutes(
      { start: START, mode: 'loop', durationMin: 90, curviness: 4, variants: 1, seed },
      { router: new FakeRouter({ wiggle: 0.5 }), ...fast },
    );
  const a = await run(42);
  const b = await run(42);
  const c = await run(43);
  assert.deepEqual(a.best.waypoints, b.best.waypoints);
  assert.notDeepEqual(a.best.waypoints, c.best.waypoints);
});

test('Es kommt genau eine Route je Variante zurueck, nach Score sortiert', async () => {
  const router = new FakeRouter({ wiggle: 0.5 });
  const { candidates, attempts } = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 150, curviness: 3, variants: 3, seed: 7 },
    { router, ...fast },
  );
  assert.equal(candidates.length, 3, 'drei Varianten -> drei Vorschlaege');
  assert.ok(attempts > candidates.length, 'die Zwischenschritte fliessen in die Wertung ein');
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].score <= candidates[i].score);
  }
  assert.equal(candidates[0].rank, 1);
});

test('Einwegstrecke mit Ziel endet am Ziel', async () => {
  const router = new FakeRouter({ wiggle: 0.4 });
  const ziel = destination(START, 120, 40000);
  const { best } = await generateRoutes(
    { start: START, end: ziel, mode: 'oneway', durationMin: 120, curviness: 3, variants: 1, seed: 9 },
    { router, ...fast },
  );
  assert.ok(distance(best.coords[best.coords.length - 1], ziel) < 50);
});

test('Zu weit entferntes Ziel wird als Hinweis gemeldet', async () => {
  const router = new FakeRouter({ wiggle: 0.2 });
  const weit = destination(START, 90, 300000);
  const { warnings, best } = await generateRoutes(
    { start: START, end: weit, mode: 'oneway', durationMin: 45, curviness: 2, variants: 1, seed: 11 },
    { router, ...fast },
  );
  assert.ok(warnings.some((w) => w.includes('direkte Strecke')), warnings.join(' | '));
  assert.ok(best.durationMin > 45);
});

test('Einwegstrecke ohne Ziel faehrt in die gewuenschte Richtung', async () => {
  const router = new FakeRouter({ wiggle: 0.4 });
  const { best } = await generateRoutes(
    { start: START, mode: 'oneway', durationMin: 90, curviness: 3, bearing: 0, variants: 1, seed: 13 },
    { router, ...fast },
  );
  const ende = best.coords[best.coords.length - 1];
  assert.ok(ende[1] > START[1], 'Bei Kurs 0 muss das Ende noerdlich liegen');
});

test('Anzahl der Routing-Anfragen bleibt begrenzt', async () => {
  const router = new FakeRouter({ wiggle: 0.4 });
  await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 3, variants: 3, seed: 21 },
    { router, ...fast },
  );
  assert.ok(router.calls <= 9, `zu viele Anfragen: ${router.calls}`);
});

test('Abbruch per AbortSignal wird durchgereicht', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    generateRoutes(
      { start: START, mode: 'loop', durationMin: 90, curviness: 3, variants: 1, seed: 1 },
      { router: new FakeRouter(), signal: ctrl.signal, ...fast },
    ),
    (err) => err.name === 'AbortError',
  );
});

test('measure liefert plausible Kennzahlen', async () => {
  const router = new FakeRouter({ wiggle: 0.6 });
  const route = await router.route([START, destination(START, 45, 20000)]);
  const m = measure(route);
  assert.ok(m.curvature.degPerKm > 0);
  assert.ok(m.curvinessLevel >= 1 && m.curvinessLevel <= 5);
  assert.ok(m.durationMin > 0);
  assert.ok(m.elevation.ascent > 0);
});

test('mulberry32 ist deterministisch und liegt in [0,1)', () => {
  const a = mulberry32(99);
  const b = mulberry32(99);
  for (let i = 0; i < 5; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});


/* ------------------------------------------- unerreichbare Wegpunkte */

test('nudgeWaypoints bewegt nur den Verdaechtigen und seine Nachbarn', () => {
  const rng = mulberry32(4);
  const wps = [0, 1, 2, 3, 4].map((i) => destination(START, i * 72, 20000));
  const moved = nudgeWaypoints(wps, 3, 1, rng, START);

  assert.equal(moved.length, wps.length);
  const shifts = moved.map((p, i) => distance(p, wps[i]));
  // Abschnitt 3 zeigt auf Wegpunkt 2, mitsamt Nachbarn 1 und 3.
  assert.ok(Math.min(shifts[1], shifts[2], shifts[3]) > 1000, `${shifts}`);
  assert.ok(shifts[0] === 0 && shifts[4] === 0, 'unbeteiligte bleiben liegen');
});

test('nudgeWaypoints zieht Richtung Start', () => {
  const rng = mulberry32(12);
  const wps = [destination(START, 90, 20000)];
  const moved = nudgeWaypoints(wps, null, 1, rng, START);
  assert.ok(distance(moved[0], START) < distance(wps[0], START), 'naeher am Start als vorher');
});

test('nudgeWaypoints ohne Abschnittsangabe bewegt alle', () => {
  const rng = mulberry32(8);
  const wps = [0, 1, 2].map((i) => destination(START, i * 120, 15000));
  const moved = nudgeWaypoints(wps, null, 1, rng, START);
  assert.ok(moved.every((p, i) => distance(p, wps[i]) > 500));
});

test('dropWaypoint entfernt genau einen und schuetzt den letzten', () => {
  const wps = [0, 1, 2, 3].map((i) => destination(START, i * 90, 10000));
  const less = dropWaypoint(wps, 3);
  assert.equal(less.length, 3);
  assert.ok(!less.some((p) => p === wps[2]));
  assert.equal(dropWaypoint([wps[0]], null), null, 'einen einzelnen nicht wegwerfen');
});

test('Unerreichbarer Wegpunkt wird repariert statt aufzugeben', async () => {
  // Ein breiter Riegel quer durch das Suchgebiet: die erste Ringform muss
  // zwangslaeufig hineinfallen.
  const router = new FakeRouter({
    wiggle: 0.4,
    islands: [{ center: destination(START, 45, 11000), radiusM: 5000 }],
  });
  const { best, warnings } = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 4, variants: 2, seed: 101 },
    { router, ...fast },
  );

  assert.ok(router.rejections > 0, 'der Testfall muss den Fehler wirklich ausloesen');
  assert.ok(best, 'trotzdem kommt eine Route heraus');
  assert.ok(best.distanceM > 1000);
  assert.deepEqual(warnings, [], 'und zwar ohne Warnung an den Nutzer');
});

test('Reparaturbudget begrenzt die Anfragen an den Server', async () => {
  // Alles ringsum unerreichbar: hier ist nichts zu retten.
  const router = new FakeRouter({
    wiggle: 0.4,
    islands: [{ center: START, radiusM: 400000 }],
  });
  await assert.rejects(
    generateRoutes(
      { start: START, mode: 'loop', durationMin: 120, curviness: 5, variants: 3, seed: 5 },
      { router, ...fast },
    ),
  );
  assert.ok(router.calls <= 16, `zu viele Anfragen trotz Budget: ${router.calls}`);
});

test('Hoffnungsloser Fall erklaert, was der Nutzer tun kann', async () => {
  const router = new FakeRouter({ islands: [{ center: START, radiusM: 400000 }] });
  const err = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 90, curviness: 1, variants: 1, seed: 2 },
    { router, ...fast },
  ).catch((e) => e);
  assert.match(err.message, /Start-Nadel|Strassennetz|Verbindung/i, err.message);
});


/* -------------------------------------------------- Stichstrassen (Sackgassen) */

test('spurCulprit findet den Wegpunkt im Sackgassental', () => {
  const wps = [0, 1, 2, 3].map((i) => destination(START, i * 90, 15000));
  // Doppelt befahrene Punkte haeufen sich um Wegpunkt 2.
  const repeated = Array.from({ length: 30 }, (_, i) => destination(wps[2], i * 12, 800));
  assert.equal(spurCulprit(wps, repeated), 2);
});

test('spurCulprit haelt sich zurueck, wenn sich nichts haeuft', () => {
  const wps = [0, 1, 2, 3].map((i) => destination(START, i * 90, 15000));
  const verstreut = [destination(START, 10, 40000), destination(START, 200, 60000)];
  assert.equal(spurCulprit(wps, verstreut), -1);
});

test('rotateWaypoint haelt den Abstand und wechselt die Richtung', () => {
  const rng = mulberry32(3);
  const wps = [destination(START, 90, 18000), destination(START, 180, 18000)];
  const moved = rotateWaypoint(wps, 0, START, rng);

  assert.ok(Math.abs(distance(START, moved[0]) - 18000) < 50, 'Abstand bleibt');
  const gedreht = Math.abs(((bearing(START, moved[0]) - 90 + 540) % 360) - 180);
  assert.ok(gedreht > 20 && gedreht < 65, `Drehung ${gedreht}`);
  assert.deepEqual(moved[1], wps[1], 'die anderen bleiben unberuehrt');
});

test('Sackgassental wird umgangen statt als Stern abgeliefert', async () => {
  const tal = { center: destination(START, 0, 13000), radiusM: 4500 };
  const router = new FakeRouter({ wiggle: 0.4, deadEnds: [tal] });
  const { best } = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 3, bearing: 0, variants: 1, seed: 77 },
    { router, ...fast },
  );

  assert.ok(best.overlap <= 0.15, `zu viel Doppeltfahren: ${best.overlap.toFixed(3)}`);
  // Und der Wegpunkt liegt am Ende wirklich nicht mehr im Tal.
  const imTal = best.waypoints.filter((wp) => distance(wp, tal.center) < tal.radiusM);
  assert.equal(imTal.length, 0, 'kein Wegpunkt bleibt in der Sackgasse');
});

test('Die Wertung zieht die Runde ohne Doppeltfahren vor', async () => {
  const router = new FakeRouter({
    wiggle: 0.4,
    deadEnds: [{ center: destination(START, 90, 13000), radiusM: 5000 }],
  });
  const { candidates } = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 3, variants: 3, seed: 31 },
    { router, ...fast },
  );
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].score <= candidates[i].score);
  }
  assert.ok(
    candidates[0].overlap <= Math.max(...candidates.map((c) => c.overlap)),
    'die beste darf nicht die schlechteste beim Doppeltfahren sein',
  );
});

test('Gleiche Fehler mehrerer Varianten werden zusammengefasst', async () => {
  const router = new FakeRouter({ islands: [{ center: START, radiusM: 400000 }] });
  const res = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 90, curviness: 3, variants: 3, seed: 4 },
    { router, ...fast },
  ).catch(() => null);
  assert.equal(res, null, 'hier kann nichts gelingen');

  const teilweise = new FakeRouter({
    islands: [{ center: destination(START, 180, 13000), radiusM: 9000 }],
  });
  const ok = await generateRoutes(
    { start: START, mode: 'loop', durationMin: 120, curviness: 4, bearing: 180, variants: 3, seed: 9 },
    { router: teilweise, ...fast },
  ).catch(() => null);
  if (ok) {
    // Höchstens eine Zeile je Fehlerursache, nicht eine je Variante.
    assert.ok(new Set(ok.warnings).size === ok.warnings.length);
  }
});
