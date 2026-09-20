import test from 'node:test';
import assert from 'node:assert/strict';
import { downsample, niceTicks } from '../assets/js/elevation.js';

test('niceTicks liefert runde Werte innerhalb der Spanne', () => {
  const ticks = niceTicks(412, 907, 4);
  assert.ok(ticks.length >= 3 && ticks.length <= 7, `${ticks}`);
  assert.ok(ticks.every((t) => t >= 412 && t <= 907));
  const step = ticks[1] - ticks[0];
  ticks.forEach((t, i) => {
    if (i) assert.ok(Math.abs(t - ticks[i - 1] - step) < 1e-6, `ungleiche Schritte: ${ticks}`);
  });
});

test('niceTicks kommt mit einer flachen Spanne klar', () => {
  assert.deepEqual(niceTicks(300, 300, 4), [300]);
  assert.ok(niceTicks(0, 3.4, 5).length > 1);
});

test('downsample behaelt Anfang, Ende und die Obergrenze', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ km: i / 100, ele: i }));
  const out = downsample(pts, 400);
  assert.equal(out.length, 400);
  assert.equal(out[0].ele, 0);
  assert.equal(out[out.length - 1].ele, 4999);
  assert.equal(downsample(pts.slice(0, 10), 400).length, 10);
});
