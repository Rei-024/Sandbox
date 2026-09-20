/**
 * Geodaesie- und Geometrie-Helfer.
 *
 * Konvention: Ein Punkt ist immer [lon, lat] oder [lon, lat, ele] -- also
 * GeoJSON-Reihenfolge. Leaflet will [lat, lon], deshalb gibt es toLatLng().
 */

const R_EARTH = 6371008.8; // mittlerer Erdradius in Metern

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const toLatLng = (p) => [p[1], p[0]];
export const toLatLngs = (coords) => coords.map(toLatLng);

/** Entfernung zweier Punkte in Metern (Haversine). */
export function distance(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** Anfangskurs von a nach b in Grad (0 = Norden, im Uhrzeigersinn). */
export function bearing(a, b) {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Zielpunkt, ausgehend von `origin` mit Kurs `brg` (Grad) und Distanz (Meter). */
export function destination(origin, brg, distM) {
  const d = distM / R_EARTH;
  const t = toRad(brg);
  const lat1 = toRad(origin[1]);
  const lon1 = toRad(origin[0]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(t) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [((toDeg(lon2) + 540) % 360) - 180, toDeg(lat2)];
}

/** Kleinster Winkel zwischen zwei Kursen, immer 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs(((b - a + 540) % 360) - 180);
  return d;
}

/** Gesamtlaenge eines Linienzugs in Metern. */
export function lineLength(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distance(coords[i - 1], coords[i]);
  return sum;
}

/** Aufsummierte Distanz je Stuetzpunkt (Meter), gleiche Laenge wie coords. */
export function cumulativeDistance(coords) {
  const out = new Array(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1] + distance(coords[i - 1], coords[i]);
  }
  return out;
}

/**
 * Linienzug auf feste Schrittweite umtasten. Das normalisiert die sehr
 * unterschiedlichen OSM-Knotenabstaende, bevor wir Kurvigkeit messen --
 * sonst wuerde eine kleinteilig gemappte Gerade "kurviger" aussehen als eine
 * grob gemappte Kurve. Hoehen werden linear interpoliert.
 */
export function resample(coords, stepM = 30) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = distance(a, b);
    if (segLen <= 0) continue;
    let pos = stepM - carry;
    while (pos < segLen) {
      const t = pos / segLen;
      out.push(interpolate(a, b, t));
      pos += stepM;
    }
    carry = (carry + segLen) % stepM;
  }
  const last = coords[coords.length - 1];
  if (distance(out[out.length - 1], last) > 1) out.push(last);
  return out;
}

function interpolate(a, b, t) {
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (a.length > 2 && b.length > 2) p.push(a[2] + (b[2] - a[2]) * t);
  return p;
}

/**
 * Kurvigkeitsmass: Summe aller Richtungsaenderungen pro Kilometer.
 *
 * Grobe Eichung aus der Praxis (Grad pro km):
 *   < 50   Autobahn / schnurgerade Bundesstrasse
 *   ~130   normale Landstrasse
 *   ~220   huebsche Landstrasse mit Schwung
 *   ~330   richtig kurviges Geschlaengel
 *   > 450  Passstrasse / Serpentinen
 *
 * Einzelknoten werden bei 90 Grad gekappt, damit eine Wendeschleife an einer
 * Kreuzung den Wert nicht sprengt. Solche Kehren werden separat gezaehlt.
 */
export function curvature(coords, stepM = 30) {
  const pts = resample(coords, stepM);
  const lenM = lineLength(pts);
  if (pts.length < 3 || lenM < 1) {
    return { degPerKm: 0, totalTurnDeg: 0, hairpins: 0, uTurns: 0 };
  }
  let total = 0;
  let hairpins = 0;
  let uTurns = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = angleDiff(bearing(pts[i - 1], pts[i]), bearing(pts[i], pts[i + 1]));
    if (t >= 150) uTurns++;
    else if (t >= 70) hairpins++;
    total += Math.min(t, 90);
  }
  return {
    degPerKm: (total / lenM) * 1000,
    totalTurnDeg: total,
    hairpins,
    uTurns,
  };
}

/** Kurvigkeits-Kennzahl (Grad/km) auf die Skala 1..5 der App abbilden. */
export const CURVINESS_TARGETS = [50, 130, 220, 330, 450];

export function degPerKmToLevel(degPerKm) {
  const t = CURVINESS_TARGETS;
  if (degPerKm <= t[0]) return 1;
  for (let i = 1; i < t.length; i++) {
    if (degPerKm <= t[i]) {
      return i + (degPerKm - t[i - 1]) / (t[i] - t[i - 1]);
    }
  }
  return 5;
}

/** Umkehrung: welche Grad/km peilen wir fuer Stufe 1..5 an? */
export function levelToDegPerKm(level) {
  const idx = clamp(Math.round(level), 1, 5) - 1;
  return CURVINESS_TARGETS[idx];
}

/**
 * Netto-Reisegeschwindigkeit in km/h. Je kurviger, desto langsamer -- und
 * Hoehenmeter kosten zusaetzlich ein paar Prozent.
 */
export function estimateSpeedKmh(degPerKm, ascentPerKm = 0) {
  const base = 32 + 52 * Math.exp(-degPerKm / 220);
  const hills = clamp(ascentPerKm / 1000, 0, 0.12);
  return base * (1 - hills);
}

/**
 * Hoehenstatistik. Kleine Zacken (< threshold) werden weggefiltert, sonst
 * summiert sich das Rauschen der Hoehendaten zu Fantasie-Hoehenmetern auf.
 */
export function elevationStats(coords, thresholdM = 4) {
  const withEle = coords.filter((p) => p.length > 2 && Number.isFinite(p[2]));
  if (withEle.length < 2) return null;
  let ascent = 0;
  let descent = 0;
  let anchor = withEle[0][2];
  let min = anchor;
  let max = anchor;
  for (const p of withEle) {
    const e = p[2];
    if (e < min) min = e;
    if (e > max) max = e;
    if (e - anchor >= thresholdM) {
      ascent += e - anchor;
      anchor = e;
    } else if (anchor - e >= thresholdM) {
      descent += anchor - e;
      anchor = e;
    }
  }
  return { ascent: Math.round(ascent), descent: Math.round(descent), min, max };
}

/**
 * Anteil der Strecke, der sich selbst wiederholt.
 *
 * 0 = jede Strasse nur einmal, ~0.5 = komplett hin und auf demselben Weg
 * zurueck (mehr geht nicht, denn die Hinfahrt ist ja das Original).
 *
 * Fuer eine Runde ist das die wichtigste Qualitaetsfrage: hin und auf
 * derselben Strasse zurueck ist langweilig. Umsetzung ueber ein Raster --
 * jede Zelle, die die Route schon einmal (und nicht unmittelbar davor)
 * besucht hat, zaehlt als Wiederholung.
 */
export function overlapRatio(coords, cellM = 60) {
  const pts = resample(coords, cellM / 2);
  if (pts.length < 4) return 0;
  const seen = new Map();
  const degLat = cellM / 111320;
  let repeated = 0;
  for (let i = 0; i < pts.length; i++) {
    const lat = pts[i][1];
    const degLon = cellM / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
    const key = `${Math.round(lat / degLat)}:${Math.round(pts[i][0] / degLon)}`;
    const prev = seen.get(key);
    // Nachbarindizes sind trivialerweise dieselbe Zelle -- erst ein Wiedersehen
    // nach deutlichem Abstand ist echtes Doppeltfahren. Der erste Besuch bleibt
    // gespeichert: sonst wuerde ein Wiedersehen den Zaehler zuruecksetzen und
    // jeder zweite Punkt der Rueckfahrt fiele durch.
    if (prev !== undefined && i - prev > 20) repeated++;
    else if (prev === undefined) seen.set(key, i);
  }
  return repeated / pts.length;
}

/** Douglas-Peucker, damit wir z.B. fuer Google Maps wenige Stuetzpunkte haben. */
export function simplify(coords, toleranceM = 200) {
  if (coords.length < 3) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(coords[i], coords[first], coords[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function perpendicularDistance(p, a, b) {
  const len = distance(a, b);
  if (len < 1e-6) return distance(p, a);
  // Lokale Naeherung in Metern reicht auf diesen Distanzen voellig.
  const mLat = 111320;
  const mLon = 111320 * Math.cos(toRad(a[1]));
  const ax = 0;
  const ay = 0;
  const bx = (b[0] - a[0]) * mLon;
  const by = (b[1] - a[1]) * mLat;
  const px = (p[0] - a[0]) * mLon;
  const py = (p[1] - a[1]) * mLat;
  const t = clamp(((px - ax) * bx + (py - ay) * by) / (bx * bx + by * by), 0, 1);
  return Math.hypot(px - bx * t, py - by * t);
}

/** Gleichmaessig verteilte Punkte entlang der Route (inkl. Start und Ziel). */
export function sampleAlong(coords, count) {
  const cum = cumulativeDistance(coords);
  const total = cum[cum.length - 1];
  if (total <= 0 || count < 2) return [coords[0]];
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (j < cum.length - 1 && cum[j + 1] < target) j++;
    out.push(coords[Math.min(j, coords.length - 1)]);
  }
  return out;
}
