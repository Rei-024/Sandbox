import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearing,
  curvature,
  degPerKmToLevel,
  destination,
  distance,
  elevationStats,
  estimateSpeedKmh,
  lineLength,
  overlapRatio,
  resample,
  sampleAlong,
  simplify,
} from '../assets/js/geo.js';

const FREUDENSTADT = [8.4117, 48.4636];

test('destination und distance sind zueinander invers', () => {
  const p = destination(FREUDENSTADT, 42, 12345);
  assert.ok(Math.abs(distance(FREUDENSTADT, p) - 12345) < 1);
  assert.ok(Math.abs(bearing(FREUDENSTADT, p) - 42) < 0.1);
});

test('resample erhaelt Laenge und setzt gleichmaessige Schritte', () => {
  const line = [0, 1, 2, 3].map((i) => destination(FREUDENSTADT, 90, i * 1000));
  const rs = resample(line, 100);
  assert.ok(Math.abs(lineLength(rs) - 3000) < 5);
  assert.ok(Math.abs(distance(rs[0], rs[1]) - 100) < 1);
});

test('Kurvigkeit: Gerade ~0, enger Kreis deutlich hoeher', () => {
  const straight = [0, 1, 2].map((i) => destination(FREUDENSTADT, 0, i * 2000));
  assert.ok(curvature(straight).degPerKm < 1);

  const circle = [];
  for (let i = 0; i <= 72; i++) circle.push(destination(FREUDENSTADT, i * 5, 300));
  const c = curvature(circle);
  // Voller Kreis mit r = 300 m: 360 Grad auf 1.885 km => ~191 Grad/km
  assert.ok(c.degPerKm > 170 && c.degPerKm < 210, `degPerKm=${c.degPerKm}`);
});

test('Kurvigkeitsstufen treffen die Eichpunkte genau', () => {
  assert.equal(degPerKmToLevel(50).toFixed(2), '1.00');
  assert.equal(degPerKmToLevel(220).toFixed(2), '3.00');
  assert.equal(degPerKmToLevel(450).toFixed(2), '5.00');
  assert.equal(degPerKmToLevel(9999), 5);
});

test('Geschwindigkeit faellt mit der Kurvigkeit', () => {
  assert.ok(estimateSpeedKmh(50) > estimateSpeedKmh(220));
  assert.ok(estimateSpeedKmh(220) > estimateSpeedKmh(450));
  assert.ok(estimateSpeedKmh(450) > 30);
});

test('Hoehenstatistik filtert Rauschen weg', () => {
  const noisy = [];
  for (let i = 0; i < 200; i++) {
    noisy.push([...destination(FREUDENSTADT, 90, i * 50), 400 + (i % 2)]);
  }
  const stats = elevationStats(noisy);
  assert.equal(stats.ascent, 0, 'Ein-Meter-Zacken duerfen keine Hoehenmeter ergeben');

  const hill = [];
  for (let i = 0; i < 100; i++) {
    hill.push([...destination(FREUDENSTADT, 90, i * 50), 400 + i * 3]);
  }
  assert.ok(Math.abs(elevationStats(hill).ascent - 297) < 10);
});

test('overlapRatio erkennt Hin-und-zurueck auf derselben Strasse', () => {
  const out = [];
  for (let i = 0; i <= 60; i++) out.push(destination(FREUDENSTADT, 0, i * 200));
  const there = out.concat(out.slice().reverse());
  const loop = [];
  for (let i = 0; i <= 120; i++) loop.push(destination(FREUDENSTADT, i * 3, 4000));

  // Perfekte Wendestrecke: die Haelfte der Punkte ist Wiederholung.
  assert.ok(overlapRatio(there) > 0.45, `Wendestrecke: ${overlapRatio(there)}`);
  assert.ok(overlapRatio(loop) < 0.1, 'Echte Runde darf kaum ueberlappen');
});

test('simplify behaelt Anfang, Ende und markante Punkte', () => {
  const line = [];
  for (let i = 0; i <= 50; i++) line.push(destination(FREUDENSTADT, i % 2 ? 80 : 100, i * 400));
  const s = simplify(line, 200);
  assert.ok(s.length < line.length);
  assert.deepEqual(s[0], line[0]);
  assert.deepEqual(s[s.length - 1], line[line.length - 1]);
});

test('sampleAlong liefert die gewuenschte Punktzahl', () => {
  const line = [];
  for (let i = 0; i <= 40; i++) line.push(destination(FREUDENSTADT, 45, i * 500));
  assert.equal(sampleAlong(line, 8).length, 8);
});
