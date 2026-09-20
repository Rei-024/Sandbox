import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRoutes, measure, mulberry32, targetDistanceM } from '../assets/js/generator.js';
import { destination, distance } from '../assets/js/geo.js';
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
