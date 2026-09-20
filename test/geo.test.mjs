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
  exciseSpurs,
  lineLength,
  overlapPercent,
  overlapRatio,
  retraceRatio,
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

/* ----------------------------------------------- Sackgassen-Aeste schneiden */

/** Hauptweg nach Osten, mit einem Ast nach Norden und zurueck. */
function routeMitAst({ astKm = 3, bei = 20, hauptKm = 10 } = {}) {
  const schritte = hauptKm * 4;
  const haupt = [];
  for (let i = 0; i <= schritte; i++) haupt.push(destination(FREUDENSTADT, 90, i * 250));
  const kreuzung = haupt[bei];
  const ast = [];
  for (let i = 1; i <= astKm * 4; i++) ast.push(destination(kreuzung, 0, i * 250));
  return [...haupt.slice(0, bei + 1), ...ast, ...ast.slice(0, -1).reverse(), ...haupt.slice(bei + 1)];
}

test('exciseSpurs schneidet den Ast heraus und laesst den Hauptweg stehen', () => {
  const mitAst = routeMitAst();
  const { coords, cuts, removedM } = exciseSpurs(mitAst);

  assert.equal(cuts, 1);
  assert.ok(removedM > 5000 && removedM < 6500, `entfernt: ${removedM}`);
  assert.ok(overlapRatio(coords) < 0.02, `Rest doppelt: ${overlapPercent(overlapRatio(coords))} %`);
  assert.deepEqual(coords[0], mitAst[0], 'Anfang bleibt');
  assert.deepEqual(coords[coords.length - 1], mitAst[mitAst.length - 1], 'Ende bleibt');
});

test('Der Schnitt hinterlaesst keine Luecke im Streckenverlauf', () => {
  // Die entscheidende Eigenschaft: was uebrig bleibt, muss durchgehend
  // befahrbar sein. Ein Ast ist ein geschlossener Teilweg, also darf an der
  // Schnittstelle kein Sprung entstehen.
  //
  // Bewusst mit 25-m-Knoten wie echte Routerausgabe: mit dem groben
  // 250-m-Raster der anderen Fixtures waere die Schranke so weit, dass sie
  // jede denkbare Luecke durchliesse und gar nichts pruefte.
  const fein = [];
  for (let i = 0; i <= 400; i++) fein.push(destination(FREUDENSTADT, 90, i * 25));
  const ast = [];
  for (let i = 1; i <= 120; i++) ast.push(destination(fein[200], 0, i * 25));
  const mitAst = [...fein.slice(0, 201), ...ast, ...ast.slice(0, -1).reverse(), ...fein.slice(201)];

  const joinM = 35;
  const { coords, cuts } = exciseSpurs(mitAst, { joinM });
  assert.equal(cuts, 1);

  const nachher = Math.max(...coords.slice(1).map((p, i) => distance(coords[i], p)));
  // Schranke: ein Originalsegment (25 m) plus die erlaubte Schliessdistanz.
  assert.ok(nachher <= 25 + joinM + 1, `Sprung von ${nachher.toFixed(0)} m entstanden`);
});

test('Aeste werden auch auf maeandernden Routen gefunden', () => {
  // Regression: erst wurde nach Laenge sortiert und nur die vordersten
  // geprueft. Auf einer Route, die sich staendig selbst nahekommt, standen
  // Dutzende lange Nachbarschaften vor den echten Aesten -- das Schneiden
  // fiel dort vollstaendig aus, ohne dass irgendetwas auffiel.
  const route = [];
  for (let runde = 0; runde < 40; runde++) {
    for (let i = 0; i <= 60; i++) {
      const mitte = destination(FREUDENSTADT, 90, runde * 120);
      route.push(destination(mitte, runde % 2 ? 180 - i * 3 : i * 3, 2500));
    }
  }
  for (const bei of [400, 1200, 2000]) {
    const ast = [];
    let p = route[bei];
    for (let i = 0; i < 60; i++) {
      p = destination(p, 70, 50);
      ast.push(p);
    }
    route.splice(bei + 1, 0, ...ast, ...ast.slice(0, -1).reverse());
  }
  const { cuts, removedM } = exciseSpurs(route);
  assert.equal(cuts, 3, 'alle drei Aeste');
  assert.ok(removedM > 15000, `nur ${(removedM / 1000).toFixed(1)} km entfernt`);
});

test('Mehrere Schnitte fressen zusammen nie mehr als die Haelfte', () => {
  // Regression: der Deckel galt je Schnitt und wurde gegen die schon
  // geschrumpfte Route gerechnet. Zehn Schnitte hintereinander liessen von
  // einer Wendestrecke einen Stummel uebrig.
  const hin = [];
  for (let i = 0; i <= 480; i++) hin.push(destination(FREUDENSTADT, 45, i * 50));
  const wende = [...hin, ...hin.slice(0, -1).reverse()];
  const gesamt = lineLength(wende);

  const { coords, removedM } = exciseSpurs(wende);
  assert.ok(removedM <= gesamt * 0.5 + 1, `${(removedM / gesamt * 100).toFixed(0)} % entfernt`);
  assert.ok(lineLength(coords) >= gesamt * 0.45, 'es muss die halbe Strecke übrig bleiben');
});

test('Eine echte Runde wird nicht angetastet', () => {
  const runde = [];
  for (let i = 0; i <= 180; i++) runde.push(destination(FREUDENSTADT, i * 2, 8000));
  const { coords, cuts } = exciseSpurs(runde);
  assert.equal(cuts, 0);
  assert.equal(coords.length, runde.length);
});

test('Eine kleine Schleife bleibt, ein Ast gleicher Laenge geht', () => {
  // Rein und auf anderem Weg heraus ist kein Doppeltfahren -- das soll bleiben.
  const haupt = [];
  for (let i = 0; i <= 40; i++) haupt.push(destination(FREUDENSTADT, 90, i * 250));
  const ab = haupt[20];
  const schleife = [];
  for (let i = 1; i < 36; i++) schleife.push(destination(ab, i * 10, 1200));
  const mitSchleife = [...haupt.slice(0, 21), ...schleife, ...haupt.slice(20)];

  assert.equal(exciseSpurs(mitSchleife).cuts, 0, 'Schleife darf nicht fallen');
  assert.equal(exciseSpurs(routeMitAst({ astKm: 1.2 })).cuts, 1, 'Ast schon');
});

test('Mehrere Aeste werden nacheinander entfernt', () => {
  const haupt = [];
  for (let i = 0; i <= 80; i++) haupt.push(destination(FREUDENSTADT, 90, i * 250));
  const astAn = (index, km) => {
    const a = [];
    for (let i = 1; i <= km * 4; i++) a.push(destination(haupt[index], 0, i * 250));
    return [...a, ...a.slice(0, -1).reverse()];
  };
  const mit = [
    ...haupt.slice(0, 21), ...astAn(20, 2),
    ...haupt.slice(21, 51), ...astAn(50, 2.5),
    ...haupt.slice(51),
  ];
  const { cuts, coords } = exciseSpurs(mit);
  assert.equal(cuts, 2);
  assert.ok(overlapRatio(coords) < 0.02);
});

test('exciseSpurs bleibt bei kurzen und entarteten Eingaben ruhig', () => {
  assert.equal(exciseSpurs([]).cuts, 0);
  assert.equal(exciseSpurs([FREUDENSTADT]).coords.length, 1);
  const zwei = [FREUDENSTADT, destination(FREUDENSTADT, 0, 100)];
  assert.deepEqual(exciseSpurs(zwei).coords, zwei);
});

test('retraceRatio trennt Wendestrecke von Runde', () => {
  const hin = [];
  for (let i = 0; i <= 40; i++) hin.push(destination(FREUDENSTADT, 45, i * 300));
  assert.ok(retraceRatio([...hin, ...hin.slice(0, -1).reverse()]) > 0.9, 'hin und zurück');

  const runde = [];
  for (let i = 0; i <= 180; i++) runde.push(destination(FREUDENSTADT, i * 2, 8000));
  assert.ok(retraceRatio(runde) < 0.1, 'echte Runde');

  assert.equal(retraceRatio([FREUDENSTADT]), 0, 'zu kurz zum Urteilen');
});

test('Auch kurze Aeste werden erkannt', () => {
  // overlapRatio unterschaetzt die: seine Mindestdistanz zwischen zwei
  // Besuchen greift auf kurzen Teilwegen nicht. Deshalb retraceRatio.
  assert.equal(exciseSpurs(routeMitAst({ astKm: 0.5 })).cuts, 1);
});
