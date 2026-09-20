/**
 * Das Strassennetz kennenlernen, bevor Wegpunkte gesetzt werden.
 *
 * Wegpunkte auf einen gedachten Kreis zu wuerfeln funktioniert im Flachland.
 * Im Gebirge liegt der halbe Kreis am Berg: die Punkte landen auf Waldwegen,
 * in Sackgassentaelern oder ganz ohne Strasse in der Naehe. Genau daher kamen
 * die Inselfehler und die Sternrouten.
 *
 * Deshalb wird einmal je Suche das echte Strassennetz der Gegend abgefragt
 * (Overpass/OpenStreetMap) und jeder Wunschpunkt auf eine tatsaechlich
 * vorhandene Strasse gezogen -- und zwar auf eine, deren Klasse zur
 * gewuenschten Kurvigkeit passt.
 *
 * Faellt Overpass aus, arbeitet die App weiter wie bisher. Schlechter, aber
 * nicht kaputt.
 */

import { distance, resample } from './geo.js';
import { fetchWithTimeout } from './routers.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Strassenklassen, die fuers Motorrad taugen -- absteigend nach Groesse. */
export const ROAD_CLASSES = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential'];

const CLASS_RANK = Object.fromEntries(ROAD_CLASSES.map((c, i) => [c, i]));

/**
 * Abfrage fuer einen Umkreis. `out tags center` liefert je Weg nur Tags und
 * einen Mittelpunkt statt der ganzen Geometrie -- das haelt die Antwort klein
 * genug fuers Mobilnetz.
 */
export function buildOverpassQuery(center, radiusM, limit = 2000) {
  const r = Math.round(radiusM);
  const lat = center[1].toFixed(5);
  const lon = center[0].toFixed(5);
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(${ROAD_CLASSES.join('|')})$"]` +
    `["access"!~"^(private|no|customers)$"]` +
    `["motor_vehicle"!~"^(private|no)$"]` +
    `(around:${r},${lat},${lon});` +
    `out tags center ${Math.round(limit)};`
  );
}

/** Overpass-Antwort auf das Noetige eindampfen. */
export function parseOverpassRoads(json) {
  const roads = [];
  for (const el of json?.elements ?? []) {
    const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    const highway = el.tags?.highway;
    if (!c || !highway || !(highway in CLASS_RANK)) continue;
    roads.push({
      point: [c.lon, c.lat],
      highway,
      name: el.tags.name ?? el.tags.ref ?? null,
      toll: el.tags.toll === 'yes',
    });
  }
  return roads;
}

/**
 * Aufschlag in Metern, wenn die Strassenklasse nicht zum Wunsch passt.
 *
 * Wer zuegig fahren will, soll auf Landes- und Bundesstrassen landen; wer
 * kurvig will, auf Nebenstrassen. Das ist der erste Hebel fuer Kurvigkeit,
 * der wirklich weiss, worueber er redet -- bisher liess sie sich nur ueber
 * die Anzahl der Wegpunkte erraten.
 */
export function classPenaltyM(highway, curviness) {
  const rank = CLASS_RANK[highway] ?? 3;
  const wanted = ((curviness - 1) / 4) * 3; // 0 = primary ... 3 = unclassified
  const mismatch = Math.abs(rank - wanted) * 900;
  // Wohnstrassen sind selten ein Fahrvergnuegen, egal was gewuenscht war.
  return mismatch + (highway === 'residential' ? 800 : 0);
}

/**
 * Wunschpunkte auf echte Strassen ziehen.
 *
 * Zwei Wegpunkte duerfen nicht auf derselben Strasse landen -- sonst faellt
 * die Runde in sich zusammen. Findet sich im Umkreis nichts, bleibt der
 * Wunschpunkt stehen; darum kuemmert sich dann die Reparatur im Generator.
 */
export function snapWaypoints(
  waypoints,
  roads,
  { curviness = 3, maxSnapM = 6000, avoidToll = true } = {},
) {
  if (!roads?.length) return waypoints;
  const taken = [];
  return waypoints.map((wp) => {
    let best = null;
    let bestCost = Infinity;
    for (const road of roads) {
      if (avoidToll && road.toll) continue;
      const d = distance(wp, road.point);
      if (d > maxSnapM) continue;
      if (taken.some((t) => distance(t, road.point) < 400)) continue;
      const cost = d + classPenaltyM(road.highway, curviness);
      if (cost < bestCost) {
        bestCost = cost;
        best = road.point;
      }
    }
    if (best) taken.push(best);
    return best ?? wp;
  });
}

/** Strassennetz rund um einen Punkt holen. Wirft, wenn kein Server antwortet. */
export async function fetchRoadNetwork(
  center,
  radiusM,
  { signal, endpoints = OVERPASS_ENDPOINTS, limit = 2000 } = {},
) {
  const query = buildOverpassQuery(center, radiusM, limit);
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(),
          signal,
        },
        25000,
      );
      if (!res.ok) {
        lastError = new Error(`Overpass antwortet mit HTTP ${res.status}.`);
        continue;
      }
      const roads = parseOverpassRoads(await res.json());
      if (roads.length) return roads;
      lastError = new Error('In dieser Gegend hat Overpass keine passenden Straßen gefunden.');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('Straßennetz nicht verfügbar.');
}

/**
 * Mautstrassen, an denen die fertige Route entlangfuehrt.
 *
 * Wir kennen von jeder Strasse nur einen Mittelpunkt, nicht ihren Verlauf --
 * das reicht fuer einen Hinweis, nicht fuer eine Gewissheit. Deshalb heisst
 * es in der Oberflaeche auch "moeglicherweise".
 *
 * Die Route wird vorher auf feste Schrittweite gebracht: jeden n-ten Punkt zu
 * pruefen wuerde je nach Knotendichte ueber eine Mautstrasse hinwegspringen.
 */
export function tollRoadsNear(coords, roads, { thresholdM = 250, sampleM = 100 } = {}) {
  const maut = roads.filter((r) => r.toll);
  if (!maut.length) return [];
  const treffer = new Set();
  for (const p of resample(coords, sampleM)) {
    for (const road of maut) {
      if (distance(p, road.point) < thresholdM) {
        treffer.add(road.name ?? 'unbenannte Mautstraße');
      }
    }
  }
  return [...treffer];
}

/**
 * Mautstrassen als Sperrzonen, wie BRouter sie versteht: [lon, lat, radius].
 *
 * Overpass weiss, *wo* die Mautstrassen liegen; BRouter weiss, wie man einen
 * Ort umfaehrt. Das zusammenzubringen ist billiger als ein zweiter
 * Routing-Dienst -- es kostet keine einzige zusaetzliche Anfrage.
 *
 * Der Radius bleibt klein: gesperrt wird ein Stueck der Strasse, nicht die
 * halbe Landschaft. Und die Zahl ist gedeckelt, damit die URL nicht platzt
 * und nicht versehentlich ein ganzes Tal zugemauert wird.
 */
export function tollNogos(roads, { radiusM = 250, limit = 25, near = null } = {}) {
  let maut = roads.filter((r) => r.toll);
  if (near) {
    maut = maut.sort((a, b) => distance(near, a.point) - distance(near, b.point));
  }
  return maut.slice(0, limit).map((r) => [r.point[0], r.point[1], radiusM]);
}

/** Schluessel fuer den Zwischenspeicher: grob gerundet, damit er auch greift. */
export const networkCacheKey = (center, radiusM) =>
  `${center[1].toFixed(2)},${center[0].toFixed(2)},${Math.round(radiusM / 2000)}`;
