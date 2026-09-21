/**
 * Belastungsprobe: zufaellige Welten, zufaellige Anfragen, feste Zusicherungen.
 *
 * Die Unit-Tests pruefen einzelne Funktionen an gewaehlten Beispielen. Hier
 * geht es um das Gegenteil: sehr viele Faelle, die niemand von Hand ausdenkt,
 * und die Frage, ob dabei jemals etwas herauskommt, das keine brauchbare
 * Route mehr ist.
 *
 *   node test/stress.mjs [Durchlaeufe]
 */

import {
  cumulativeDistance,
  distance,
  elevationStats,
  exciseSpurs,
  lineLength,
  overlapPercent,
} from '../assets/js/geo.js';
import { generateRoutes, mulberry32, targetDistanceM } from '../assets/js/generator.js';
import { snapWaypoints, tollNogos, tollRoadsNear } from '../assets/js/roads.js';
import { abfrageGebiet } from '../assets/js/app.js';
import { buildGpx, GOOGLE_MAX_WAYPOINTS, googleMapsUrl } from '../assets/js/export.js';
import { FakeRouter } from './fake-router.mjs';

const DURCHLAEUFE = Number(process.argv[2] ?? 200);
const START = [13.6167, 47.6417];

const verstoesse = [];
const melde = (lauf, was, detail) => verstoesse.push({ lauf, was, detail });
const pruefe = (bedingung, lauf, was, detail) => {
  if (!bedingung) melde(lauf, was, detail);
};

/* ------------------------------------------------------------ Weltenbau */

/**
 * Ein zufaelliges Strassennetz: Aussenring, Innenring, Speichen, ein paar
 * Sackgassen und optional eine Serpentinenstrecke -- alles mit Hoehen.
 */
function welt(rng, reichweiteM = 16000, korridor = []) {
  const punkte = [];
  const hoehe = (p) => 500 + 300 * Math.sin(p[0] * 60) + 200 * Math.cos(p[1] * 60);
  const strecke = (a, b, schritt = 300) => {
    const n = Math.max(2, Math.round(distance(a, b) / schritt));
    for (let s = 0; s <= n; s++) {
      const p = [a[0] + (b[0] - a[0]) * (s / n), a[1] + (b[1] - a[1]) * (s / n)];
      punkte.push([p[0], p[1], hoehe(p)]);
    }
  };

  // Mehrere Ringe und reichlich Speichen: in der Wirklichkeit gibt es fast
  // ueberall Strassen. Ein Netz aus nur zwei duennen Ringen laesst Wegpunkte
  // ins Leere fallen und misst dann die Testwelt statt der App.
  const ecken = (radius, zahl, versatz) =>
    Array.from({ length: zahl }, (_, i) =>
      ziel(START, versatz + (360 * i) / zahl, radius * (0.85 + rng() * 0.3)),
    );
  const ringe = [];
  const anzahlRinge = 4 + Math.floor(rng() * 3);
  for (let r = 1; r <= anzahlRinge; r++) {
    const radius = (reichweiteM * 1.35 * r) / anzahlRinge;
    ringe.push(ecken(radius, 6 + Math.floor(rng() * 5), rng() * 360));
  }
  for (const ring of ringe) {
    for (let i = 0; i < ring.length; i++) strecke(ring[i], ring[(i + 1) % ring.length]);
  }
  for (let r = 1; r < ringe.length; r++) {
    const innen = ringe[r - 1];
    const aussen = ringe[r];
    for (let i = 0; i < aussen.length; i++) strecke(innen[i % innen.length], aussen[i]);
  }
  for (const p of ringe[0]) strecke(START, p);

  // Bei einer Einwegstrecke zieht sich das Netz die Fahrtrichtung entlang --
  // genau so laedt die App es auch, als Schlauch statt als Scheibe.
  let vorher = START;
  for (const zentrum of korridor) {
    // Die Achse wandert, statt schnurgerade zu laufen: eine perfekt gerade
    // Verbindung haette einen Umwegfaktor von 1,05, echte Strassen liegen
    // bei 1,2 bis 1,4. Ohne das misst der Pruefstand eine Welt, die es
    // nicht gibt.
    const quer = bearingZwischen(vorher, zentrum) + 90;
    const weite = distance(vorher, zentrum);
    const knick = ziel(
      [(vorher[0] + zentrum[0]) / 2, (vorher[1] + zentrum[1]) / 2],
      quer,
      (rng() - 0.5) * weite * 0.5,
    );
    strecke(vorher, knick, 400);
    strecke(knick, zentrum, 400);
    // Ringe um jedes Korridorzentrum, und zwar bis ueber die Schlauchbreite
    // hinaus: in der Wirklichkeit hoert das Strassennetz nicht dort auf, wo
    // die App es geladen hat. Ein zu duenner Schlauch deckelt sonst die
    // erreichbare Streckenlaenge und misst die Fixture statt die App.
    for (const radius of [7000, 14000, 21000]) {
      const kranz = ecken(radius, 8, rng() * 360).map((p) => [
        p[0] + (zentrum[0] - START[0]),
        p[1] + (zentrum[1] - START[1]),
      ]);
      for (let i = 0; i < kranz.length; i++) strecke(kranz[i], kranz[(i + 1) % kranz.length]);
      for (const p of kranz) strecke(zentrum, p);
    }
    vorher = zentrum;
  }

  // Sackgassen: Stichstrassen, die irgendwo abzweigen und enden.
  const sackgassen = [];
  const aussenRing = ringe[ringe.length - 1];
  for (let i = 0; i < 3; i++) {
    const ab = aussenRing[Math.floor(rng() * aussenRing.length)];
    const spitze = ziel(ab, rng() * 360, 1500 + rng() * 3000);
    strecke(ab, spitze);
    sackgassen.push(spitze);
  }

  const inseln = Array.from({ length: Math.floor(rng() * 4) }, () => ({
    center: ziel(START, rng() * 360, reichweiteM * (0.3 + rng())),
    radiusM: 400 + rng() * 900,
  }));

  const roads = punkte.map((p, i) => ({
    point: [p[0], p[1]],
    highway: ['primary', 'secondary', 'tertiary', 'unclassified'][i % 4],
    toll: rng() < 0.02,
    name: null,
  }));

  return { korridore: punkte, roads, inseln, sackgassen };
}

const bearingZwischen = (a, b) => {
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const l1 = (a[1] * Math.PI) / 180;
  const l2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(l2);
  const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const ziel = (von, kurs, dist) => {
  const R = 6371008.8;
  const d = dist / R;
  const t = (kurs * Math.PI) / 180;
  const lat1 = (von[1] * Math.PI) / 180;
  const lon1 = (von[0] * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(((lon2 * 180) / Math.PI + 540) % 360) - 180, (lat2 * 180) / Math.PI];
};

/* --------------------------------------------------------- Zusicherungen */

function pruefeRoute(lauf, kandidat, anfrage, weltDaten) {
  const c = kandidat.coords;
  pruefe(Array.isArray(c) && c.length >= 2, lauf, 'Route hat zu wenige Punkte', c?.length);

  const kaputt = c.find(
    (p) =>
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      Math.abs(p[1]) > 90 ||
      Math.abs(p[0]) > 180,
  );
  pruefe(!kaputt, lauf, 'ungueltige Koordinate', JSON.stringify(kaputt));

  if (anfrage.mode === 'loop') {
    const zurueck = distance(c[0], c[c.length - 1]);
    pruefe(zurueck < 150, lauf, 'Runde endet nicht am Start', `${zurueck.toFixed(0)} m`);
  }
  if (anfrage.mode === 'oneway' && anfrage.end) {
    const amZiel = distance(c[c.length - 1], anfrage.end);
    pruefe(amZiel < 150, lauf, 'Einwegstrecke endet nicht am Ziel', `${amZiel.toFixed(0)} m`);
  }
  pruefe(distance(c[0], anfrage.start) < 150, lauf, 'Route beginnt nicht am Start');

  for (const [name, wert] of [
    ['distanceM', kandidat.distanceM],
    ['durationMin', kandidat.durationMin],
    ['speedKmh', kandidat.speedKmh],
    ['curvinessLevel', kandidat.curvinessLevel],
    ['overlap', kandidat.overlap],
    ['score', kandidat.score],
  ]) {
    pruefe(Number.isFinite(wert) && wert >= 0, lauf, `${name} unbrauchbar`, wert);
  }
  pruefe(kandidat.curvinessLevel >= 1 && kandidat.curvinessLevel <= 5, lauf, 'Kurvigkeit ausserhalb 1..5', kandidat.curvinessLevel);
  pruefe(kandidat.overlap <= 0.5001, lauf, 'Doppeltfahren > 50 %', kandidat.overlap);
  pruefe(
    Math.abs(lineLength(c) - kandidat.distanceM) < Math.max(50, kandidat.distanceM * 0.01),
    lauf,
    'gemeldete Laenge passt nicht zur Geometrie',
    `${(lineLength(c) / 1000).toFixed(1)} vs ${(kandidat.distanceM / 1000).toFixed(1)} km`,
  );

  // Keine Spruenge: der Fake-Router liefert Segmente bis 120 m, das
  // Herausschneiden darf hoechstens die Schliesstoleranz dazulegen.
  const groessterSprung = Math.max(...c.slice(1).map((p, i) => distance(c[i], p)));
  pruefe(groessterSprung < 260, lauf, 'Sprung in der Route', `${groessterSprung.toFixed(0)} m`);

  const hoehen = elevationStats(c);
  if (hoehen) {
    pruefe(hoehen.ascent >= 0 && hoehen.descent >= 0, lauf, 'negative Hoehenmeter');
    pruefe(hoehen.max >= hoehen.min, lauf, 'Hoehenbereich verdreht');
  }

  // GPX: wohlgeformt und vollstaendig
  const gpx = buildGpx(kandidat, { name: 'Prüflauf & <Test>', description: 'a & b' });
  pruefe(gpx.startsWith('<?xml'), lauf, 'GPX ohne XML-Kopf');
  pruefe(zaehle(gpx, '<trkpt ') === c.length, lauf, 'GPX-Punktzahl weicht ab', `${zaehle(gpx, '<trkpt ')} vs ${c.length}`);
  pruefe(!/&(?!amp;|lt;|gt;|quot;|#)/.test(gpx), lauf, 'GPX enthaelt unmaskiertes &');
  pruefe(xmlAusgeglichen(gpx), lauf, 'GPX-Tags nicht ausgeglichen');

  // Google-Maps-Link
  const url = new URL(googleMapsUrl(kandidat));
  const wp = url.searchParams.get('waypoints');
  pruefe(
    !wp || wp.split('|').length <= GOOGLE_MAX_WAYPOINTS,
    lauf,
    'zu viele Google-Zwischenziele',
    wp?.split('|').length,
  );
  pruefe(/^-?\d+\.\d+,-?\d+\.\d+$/.test(url.searchParams.get('origin')), lauf, 'Google-Start unbrauchbar');

  // Mauthinweis darf nur bei echter Maut an der Strecke anschlagen
  const maut = tollRoadsNear(c, weltDaten.roads);
  pruefe(Array.isArray(maut), lauf, 'Mautpruefung liefert keine Liste');
}

const zaehle = (text, was) => text.split(was).length - 1;

/** Grobe Wohlgeformtheit: jedes oeffnende Tag wird geschlossen, in Reihenfolge. */
function xmlAusgeglichen(xml) {
  const stapel = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, schliessend, name, rest, selbst] = m;
    if (rest.startsWith('?') || name === 'xml') continue;
    if (selbst) continue;
    if (schliessend) {
      if (stapel.pop() !== name) return false;
    } else {
      stapel.push(name);
    }
  }
  return stapel.length === 0;
}

/* ------------------------------------------------------- Geometrie-Fuzz */

function fuzzGeometrie(rng, lauf) {
  // Zufaelliger Linienzug mit eingestreuten Aesten
  let kurs = rng() * 360;
  let p = ziel(START, rng() * 360, rng() * 5000);
  const route = [];
  const n = 200 + Math.floor(rng() * 2000);
  for (let i = 0; i < n; i++) {
    kurs += (rng() - 0.5) * 40;
    p = ziel(p, kurs, 10 + rng() * 40);
    route.push([p[0], p[1], 400 + i * 0.3 * (rng() < 0.5 ? 1 : -1)]);
  }
  const vorher = lineLength(route);
  const groessterVorher = Math.max(...route.slice(1).map((q, i) => distance(route[i], q)));

  const r = exciseSpurs(route);
  pruefe(r.coords.length <= route.length, lauf, 'Schneiden hat Punkte hinzugefuegt');
  pruefe(r.coords.length >= 2, lauf, 'Schneiden hat die Route vernichtet');
  pruefe(r.removedM >= 0 && r.removedM <= vorher * 0.51, lauf, 'zu viel weggeschnitten', `${(100 * r.removedM / vorher).toFixed(0)} %`);
  pruefe(
    r.coords[0] === route[0] && distance(r.coords[r.coords.length - 1], route[route.length - 1]) < 1,
    lauf,
    'Anfang oder Ende verschoben',
  );
  const groesster = Math.max(...r.coords.slice(1).map((q, i) => distance(r.coords[i], q)));
  pruefe(
    groesster <= groessterVorher + 95,
    lauf,
    'Schneiden hat eine Luecke gerissen',
    `${groesster.toFixed(0)} m (vorher ${groessterVorher.toFixed(0)} m)`,
  );
}

/* ---------------------------------------------------------------- Lauf */

console.log(`Belastungsprobe: ${DURCHLAEUFE} Durchlaeufe\n`);
const start = Date.now();
let erfolge = 0;
let fehlschlaege = 0;
let anfragen = 0;
const overlaps = [];
const zeitfehler = [];
const ausfaelle = [];
const zeitDetail = [];

for (let lauf = 1; lauf <= DURCHLAEUFE; lauf++) {
  const rng = mulberry32(lauf * 2654435761);

  const mode = rng() < 0.7 ? 'loop' : 'oneway';
  const anfrage = {
    start: START,
    mode,
    end: null,
    endIndex: mode === 'oneway' && rng() < 0.5 ? Math.floor(rng() * 5000) : null,
    durationMin: 30 + Math.floor(rng() * 16) * 30,
    curviness: 1 + Math.floor(rng() * 5),
    bearing: mode === 'oneway' || rng() < 0.4 ? Math.floor(rng() * 8) * 45 : null,
    variants: 1 + Math.floor(rng() * 4),
    avoidMotorway: rng() < 0.8,
    avoidUnpaved: rng() < 0.8,
    avoidToll: rng() < 0.8,
    nogos: [],
    seed: lauf,
  };
  // Das Strassennetz waechst mit der gewuenschten Rundengroesse -- genau das
  // macht die echte App auch, indem sie den Overpass-Radius mitskaliert.
  const gebiet = abfrageGebiet(anfrage);
  const w = welt(
    rng,
    Math.max(6000, targetDistanceM(anfrage.durationMin, anfrage.curviness) / 6),
    anfrage.mode === 'oneway' ? gebiet.centers.slice(1) : [],
  );
  const roads = w.roads;
  if (anfrage.mode === 'oneway' && anfrage.endIndex != null) {
    anfrage.end = w.korridore[anfrage.endIndex % w.korridore.length].slice(0, 2);
  }
  if (anfrage.avoidToll) {
    anfrage.nogos = tollNogos(roads, { keepClear: [anfrage.start, anfrage.end] });
  }

  const router = new FakeRouter({
    wiggle: 0.2 + rng() * 0.7,
    corridors: w.korridore.map((p) => [p[0], p[1]]),
    corridorWidthM: 700 + rng() * 600,
    islands: w.inseln,
  });

  let ergebnis = null;
  try {
    ergebnis = await generateRoutes(anfrage, {
      router,
      requestGapMs: 0,
      snap: (wps) => snapWaypoints(wps, roads, { curviness: anfrage.curviness, avoidToll: anfrage.avoidToll }),
    });
  } catch (err) {
    fehlschlaege++;
    ausfaelle.push({ mode: anfrage.mode, dauer: anfrage.durationMin, kurvig: anfrage.curviness, grund: err.message.slice(0, 45) });
    pruefe(
      typeof err.message === 'string' && err.message.length > 10,
      lauf,
      'Fehlermeldung unbrauchbar',
      err.message,
    );
    pruefe(!/undefined|NaN|\[object/.test(err.message), lauf, 'Fehlermeldung enthaelt Technikmuell', err.message);
  }
  anfragen += router.calls;
  pruefe(router.calls <= 45, lauf, 'zu viele Routing-Anfragen', router.calls);

  if (ergebnis) {
    erfolge++;
    pruefe(ergebnis.candidates.length >= 1, lauf, 'keine Kandidaten trotz Erfolg');
    pruefe(
      ergebnis.candidates.length <= anfrage.variants,
      lauf,
      'mehr Vorschlaege als Varianten',
      `${ergebnis.candidates.length} > ${anfrage.variants}`,
    );
    const ids = new Set(ergebnis.candidates.map((c) => c.id));
    pruefe(ids.size === ergebnis.candidates.length, lauf, 'doppelte Kandidaten-Kennung');
    ergebnis.candidates.forEach((c, i) => {
      pruefe(c.rank === i + 1, lauf, 'Rangfolge unstimmig', `${c.rank} an Stelle ${i + 1}`);
      pruefeRoute(lauf, c, anfrage, w);
    });
    overlaps.push(ergebnis.best.overlap);
    const fehler = Math.abs(ergebnis.best.durationMin - anfrage.durationMin) / anfrage.durationMin;
    zeitfehler.push(fehler);
    zeitDetail.push({ dauer: anfrage.durationMin, kurvig: anfrage.curviness, mode: anfrage.mode, mitZiel: !!anfrage.end, fehler, ist: ergebnis.best.durationMin });
  }

  fuzzGeometrie(rng, lauf);
}

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : 0);

console.log(`Dauer: ${((Date.now() - start) / 1000).toFixed(1)} s`);
console.log(`Erfolgreich:        ${erfolge}/${DURCHLAEUFE}  (ohne Route: ${fehlschlaege})`);
console.log(`Anfragen je Lauf:   ${(anfragen / DURCHLAEUFE).toFixed(1)}`);
console.log(`Doppeltfahren:      Median ${overlapPercent(med(overlaps))} %, P90 ${overlapPercent(p90(overlaps))} %`);
console.log(`Zeitabweichung:     Median ${(med(zeitfehler) * 100).toFixed(0)} %, P90 ${(p90(zeitfehler) * 100).toFixed(0)} %`);

if (process.env.DETAIL) {
  const nachDauer = new Map();
  for (const a of ausfaelle) {
    const k = `${a.mode} ${a.dauer} min`;
    nachDauer.set(k, (nachDauer.get(k) ?? 0) + 1);
  }
  console.log('\nAusfaelle nach Anfrage:');
  for (const [k, n] of [...nachDauer].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n}x  ${k}`);
  const gruende = new Map();
  for (const a of ausfaelle) gruende.set(a.grund, (gruende.get(a.grund) ?? 0) + 1);
  console.log('Gruende:');
  for (const [k, n] of [...gruende].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`);

  const gruppen = { 'loop': [], 'oneway ohne Ziel': [], 'oneway mit Ziel': [] };
  for (const z of zeitDetail) {
    gruppen[z.mode === 'loop' ? 'loop' : z.mitZiel ? 'oneway mit Ziel' : 'oneway ohne Ziel'].push(z.fehler);
  }
  console.log('\nZeitabweichung nach Art:');
  for (const [k, v] of Object.entries(gruppen)) {
    if (!v.length) continue;
    const sortiert = [...v].sort((a, b) => a - b);
    console.log(`  ${k.padEnd(18)} n=${String(v.length).padStart(3)}  Median ${(sortiert[Math.floor(v.length / 2)] * 100).toFixed(0)} %  P90 ${(sortiert[Math.floor(v.length * 0.9)] * 100).toFixed(0)} %`);
  }

  console.log('\nGroesste Zeitabweichungen:');
  for (const z of [...zeitDetail].sort((a, b) => b.fehler - a.fehler).slice(0, 10)) {
    console.log(`  gewuenscht ${String(z.dauer).padStart(3)} min -> ${z.ist.toFixed(0).padStart(3)} min  (${(z.fehler * 100).toFixed(0)} %, ${z.mode}${z.mitZiel ? ' mit Ziel' : ''})`);
  }
}

if (!verstoesse.length) {
  console.log('\nKeine Verstoesse gegen die Zusicherungen.');
} else {
  const nachArt = new Map();
  for (const v of verstoesse) {
    if (!nachArt.has(v.was)) nachArt.set(v.was, []);
    nachArt.get(v.was).push(v);
  }
  console.log(`\n${verstoesse.length} Verstoesse in ${nachArt.size} Kategorien:`);
  for (const [was, liste] of [...nachArt].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(liste.length).padStart(4)}x  ${was}`);
    for (const v of liste.slice(0, 3)) console.log(`          Lauf ${v.lauf}: ${v.detail ?? ''}`);
  }
}
process.exit(verstoesse.length ? 1 : 0);
