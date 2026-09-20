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
 * Liefert ausserdem die doppelt befahrenen Punkte -- damit laesst sich der
 * Wegpunkt finden, der die Stichstrasse verursacht hat.
 *
 * Fuer eine Runde ist das die wichtigste Qualitaetsfrage: hin und auf
 * derselben Strasse zurueck ist langweilig. Umsetzung ueber ein Raster --
 * jede Zelle, die die Route schon einmal (und nicht unmittelbar davor)
 * besucht hat, zaehlt als Wiederholung.
 */
export function overlapDetail(coords, cellM = 60) {
  const pts = resample(coords, cellM / 2);
  if (pts.length < 4) return { ratio: 0, repeated: [] };
  const seen = new Map();
  const degLat = cellM / 111320;
  const repeated = [];
  for (let i = 0; i < pts.length; i++) {
    const lat = pts[i][1];
    const degLon = cellM / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
    const key = `${Math.round(lat / degLat)}:${Math.round(pts[i][0] / degLon)}`;
    const prev = seen.get(key);
    // Nachbarindizes sind trivialerweise dieselbe Zelle -- erst ein Wiedersehen
    // nach deutlichem Abstand ist echtes Doppeltfahren. Der erste Besuch bleibt
    // gespeichert: sonst wuerde ein Wiedersehen den Zaehler zuruecksetzen und
    // jeder zweite Punkt der Rueckfahrt fiele durch.
    if (prev !== undefined && i - prev > 20) repeated.push(pts[i]);
    else if (prev === undefined) seen.set(key, i);
  }
  return { ratio: repeated.length / pts.length, repeated };
}

export const overlapRatio = (coords, cellM = 60) => overlapDetail(coords, cellM).ratio;

/**
 * Anteil der Strecke, den man zweimal faehrt, als Prozentwert fuer die
 * Oberflaeche: komplett hin und zurueck sind 100 %, nicht 50.
 */
export const overlapPercent = (ratio) => Math.min(100, Math.round(ratio * 200));

/**
 * Wie viel eines Teilwegs faehrt die Rueckrichtung auf der Hinrichtung?
 *
 * Fuer die Frage "ist das ein Ast oder eine Schleife" ist overlapRatio das
 * falsche Mass: es verlangt einen Mindestabstand zwischen zwei Besuchen
 * derselben Zelle und unterschaetzt darum kurze Aeste systematisch. Hier
 * wird stattdessen die erste Haelfte gegen die zweite gehalten -- bei einem
 * Ast deckt sich fast alles, bei einer Schleife fast nichts.
 *
 * 1 = komplett zurueckgefahren, 0 = kein gemeinsamer Meter.
 */
export function retraceRatio(coords, toleranceM = 40, sampleM = 30) {
  const pts = resample(coords, sampleM);
  if (pts.length < 6) return 0;
  const mitte = Math.floor(pts.length / 2);
  const hin = pts.slice(0, mitte);
  const zurueck = pts.slice(mitte);

  const degLat = toleranceM / 111320;
  const degLonAt = (lat) => toleranceM / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
  const zellen = new Map();
  for (const p of zurueck) {
    const key = `${Math.round(p[1] / degLat)}:${Math.round(p[0] / degLonAt(p[1]))}`;
    if (!zellen.has(key)) zellen.set(key, []);
    zellen.get(key).push(p);
  }

  let treffer = 0;
  for (const p of hin) {
    const row = Math.round(p[1] / degLat);
    const col = Math.round(p[0] / degLonAt(p[1]));
    let gefunden = false;
    // Auch die Nachbarzellen pruefen -- ein Punkt knapp an der Zellgrenze
    // faende seinen Partner sonst nicht.
    for (let dr = -1; dr <= 1 && !gefunden; dr++) {
      for (let dc = -1; dc <= 1 && !gefunden; dc++) {
        for (const q of zellen.get(`${row + dr}:${col + dc}`) ?? []) {
          if (distance(p, q) <= toleranceM) {
            gefunden = true;
            break;
          }
        }
      }
    }
    if (gefunden) treffer++;
  }
  return treffer / hin.length;
}

/**
 * Sackgassen-Aeste aus einer fertigen Route herausschneiden.
 *
 * Ein "Ast" ist eine Stelle, an der die Route von einer Kreuzung wegfaehrt,
 * in ein Tal hineinlaeuft und auf demselben Weg zu genau dieser Kreuzung
 * zurueckkommt. Genau das entsteht, wenn ein Wegpunkt in einer Sackgasse
 * liegt -- und genau das nervt beim Fahren.
 *
 * Der Trick: so ein Ast ist ein *geschlossener* Teilweg. Schneidet man ihn
 * heraus, springt die Route von der Kreuzung zur Kreuzung -- sie bleibt also
 * durchgehend und befahrbar. Es braucht keine neue Routing-Anfrage, weil
 * nichts neu berechnet werden muss: was uebrig bleibt, ist ein Teilstueck
 * der Strecke, die der Router ohnehin geliefert hat.
 *
 * Abgegrenzt wird gegen zwei Faelle, die *nicht* weg sollen:
 *   - eine kleine Schleife (rein und auf anderem Weg heraus) -- die faehrt
 *     sich nicht doppelt, erkennbar an geringem Rueckfahranteil;
 *   - die Runde selbst, deren Anfang und Ende naturgemaess zusammenfallen --
 *     deshalb die Deckelung auf einen Bruchteil der Gesamtlaenge.
 */
export function exciseSpurs(
  coords,
  {
    // 45 m: weit genug, dass ein Rueckweg ueber die Gegenspur als derselbe
    // Weg zaehlt, eng genug, dass getrennte Strassen es nicht tun.
    joinM = 45,
    // Hoehenunterschied an der Schliessstelle. Eine Sackgasse kehrt zur
    // selben Kreuzung zurueck, also auf dieselbe Hoehe. Serpentinenschenkel
    // liegen zwar waagerecht dicht beieinander, aber uebereinander -- ohne
    // diese Schranke wurden Bergstrassen zerschnitten.
    maxHoehendifferenzM = 12,
    minSpurM = 300,
    retraceMin = 0.6,
    maxShare = 0.6,
    maxTotalShare = 0.5,
    maxCuts = 10,
  } = {},
) {
  let path = coords.slice();
  const gesamtAnfang = lineLength(path);
  let removedM = 0;
  let cuts = 0;

  while (cuts < maxCuts) {
    // Beide Deckel beziehen sich auf die *urspruengliche* Laenge. Wuerde man
    // gegen die schon geschrumpfte Route messen, fraessen sich zehn Schnitte
    // nacheinander durch fast alles hindurch.
    const nochErlaubt = gesamtAnfang * maxTotalShare - removedM;
    if (nochErlaubt < minSpurM) break;

    const spur = findSpur(path, {
      joinM,
      maxHoehendifferenzM,
      minSpurM,
      retraceMin,
      maxCutM: Math.min(gesamtAnfang * maxShare, nochErlaubt),
    });
    if (!spur) break;
    const [i, j] = spur;
    removedM += lineLength(path.slice(i, j + 1));
    path = path.slice(0, i + 1).concat(path.slice(j + 1));
    cuts++;
  }
  return { coords: path, removedM, cuts };
}

// Wie weit duerfen Hin- und Rueckweg auseinanderliegen und trotzdem als
// derselbe Weg gelten. Muss fuer Vorfilter und volle Pruefung gleich sein --
// eine groesszuegigere Vorauswahl liess versetzte Bogen durch, die dann die
// Rangliste belegten und den echten Ast verdraengten.
const TOLERANZ_FAKTOR = 1.2;

/** Punktindex an einer bestimmten Bogenlaenge, binaer gesucht. */
function indexAt(cum, ziel, lo, hi) {
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < ziel) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Billiger Vorabtest: liegen gespiegelte Punkte des Teilwegs aufeinander?
 *
 * Bei einem Ast schon (hin und zurueck decken sich), bei einer Schleife
 * nicht (gegenueberliegende Seiten). Ein Dutzend Stichproben statt der
 * vollen Messung -- damit lassen sich *alle* Kandidaten bewerten statt nur
 * der laengsten dreissig. Genau daran ist die erste Fassung gescheitert: auf
 * einer Route, die sich oft selbst nahekommt, verdraengten lange
 * Nachbarschaften die echten Aeste aus der Liste.
 *
 * Die Toleranz muss dieselbe sein wie bei der vollen Pruefung. War sie
 * grosszuegiger, liessen sich versetzt nebeneinander laufende Bogen als
 * Aeste durchwinken -- sie belegten die Rangliste und der echte Ast kam
 * nie an die Reihe.
 */
function grobeSpiegelung(path, cum, i, j, tolM, proben = 12) {
  const laenge = cum[j] - cum[i];
  let treffer = 0;
  for (let s = 1; s <= proben; s++) {
    const t = (s / (proben + 1)) * 0.5;
    const a = indexAt(cum, cum[i] + t * laenge, i, j);
    const b = indexAt(cum, cum[j] - t * laenge, i, j);
    if (distance(path[a], path[b]) <= tolM) treffer++;
  }
  return treffer / proben;
}

/**
 * Liegen zwei Punkte auf derselben Hoehe?
 *
 * Das trennt Sackgasse und Serpentine sauber: eine Sackgasse kehrt zur selben
 * Kreuzung zurueck (kein Hoehenunterschied), zwei Serpentinenschenkel liegen
 * waagerecht dicht beieinander, aber uebereinander. Ohne Hoehenangaben
 * entscheidet die Richtungspruefung allein -- dann wird im Zweifel nicht
 * geschnitten.
 */
function gleicheHoehe(a, b, maxDiffM) {
  if (!Number.isFinite(a[2]) || !Number.isFinite(b[2])) return true;
  return Math.abs(a[2] - b[2]) <= maxDiffM;
}

/**
 * Faehrt die Route hinter dem Teilweg in dieselbe Richtung weiter wie davor?
 *
 * Das unterscheidet eine Sackgasse von einer Serpentine, und das ist der
 * entscheidende Unterschied:
 *
 *   Sackgasse -- die Route kommt von Westen an eine Kreuzung, biegt nach
 *   Norden ins Tal ab, kommt zurueck und faehrt nach Osten weiter. Vorher
 *   und nachher: dieselbe Richtung. Der Ast ist ein Anhaengsel.
 *
 *   Serpentine -- die Route faehrt einen Schenkel nach Osten, nimmt die Kehre
 *   und den naechsten Schenkel nach Westen. Vorher und nachher: entgegen-
 *   gesetzt. Hier waere das "Herausschneiden" kein Anhaengsel, sondern das
 *   Wegwerfen der halben Bergstrasse.
 *
 * Ohne diese Pruefung wurden Serpentinen mit 30 bis 40 Metern Schenkelabstand
 * zerschnitten -- ausgerechnet das, wofuer man ueberhaupt losfaehrt.
 */
function fuehrtWeiter(path, cum, i, j, fensterM = 120, maxWendungGrad = 100) {
  const vorIdx = indexAt(cum, cum[i] - fensterM, 0, i);
  const nachIdx = indexAt(cum, cum[j] + fensterM, j, path.length - 1);
  if (vorIdx >= i || nachIdx <= j) return true; // am Rand nicht beurteilbar

  const davor = bearing(path[vorIdx], path[i]);
  const danach = bearing(path[j], path[nachIdx]);
  return angleDiff(davor, danach) <= maxWendungGrad;
}

/** Den laengsten herausschneidbaren Ast finden, oder null. */
function findSpur(path, { joinM, maxHoehendifferenzM, minSpurM, retraceMin, maxCutM }) {
  if (path.length < 8) return null;
  const cum = cumulativeDistance(path);
  const total = cum[cum.length - 1];
  if (total < minSpurM * 2) return null;

  // Punkte in ein Raster einsortieren, damit wir nicht jedes Paar pruefen.
  const degLat = joinM / 111320;
  const cells = new Map();
  const keyOf = (p) => {
    const degLon = joinM / (111320 * Math.max(0.2, Math.cos(toRad(p[1]))));
    return `${Math.round(p[1] / degLat)}:${Math.round(p[0] / degLon)}`;
  };
  path.forEach((p, i) => {
    const key = keyOf(p);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  });

  // Ueber die Zellen laufen, nicht ueber die Punkte: fuer jede Zelle zaehlen
  // nur aufeinanderfolgende Besuche. Ein Ast ist genau das -- hin, und beim
  // naechsten Mal zurueck.
  //
  // Der frueher naheliegende Weg (fuer jeden Punkt alle Partner suchen)
  // erzeugt an dichten Stellen quadratisch viele Paare; ein Deckel dagegen
  // kappt dann die hintere Haelfte der Route, und dort liegende Aeste werden
  // nie gefunden. So bleibt die Zahl der Kandidaten bei hoechstens einem je
  // Punkt -- gedeckelt und ueber die ganze Route gleich verteilt.
  const kandidaten = [];
  for (const liste of cells.values()) {
    for (let k = 1; k < liste.length; k++) {
      const i = liste[k - 1];
      const j = liste[k];
      const laenge = cum[j] - cum[i];
      if (laenge < minSpurM || laenge > maxCutM) continue;
      if (distance(path[i], path[j]) > joinM) continue;
      if (!gleicheHoehe(path[i], path[j], maxHoehendifferenzM)) continue;
      kandidaten.push([i, j, laenge]);
    }
  }
  if (!kandidaten.length) return null;

  // Nach *Ast-Aehnlichkeit* ordnen, nicht nach Laenge. Die Laenge war der
  // naheliegende Schluessel und genau der falsche: auf einer maeandernden
  // Route stehen zwei Dutzend lange Nachbarschaften vor dem echten Ast, und
  // der bekommt die volle Pruefung nie zu sehen.
  const bewertet = kandidaten
    .map((k) => [...k, grobeSpiegelung(path, cum, k[0], k[1], joinM * TOLERANZ_FAKTOR)])
    .filter((k) => k[3] >= 0.6)
    .sort((a, b) => b[3] - a[3] || b[2] - a[2]);

  // Der Vorfilter ist grob; findet er nichts, bekommen die laengsten
  // Kandidaten trotzdem noch die volle Pruefung.
  const uebrig = bewertet.length ? bewertet : [...kandidaten].sort((a, b) => b[2] - a[2]);

  for (const [i, j] of uebrig.slice(0, 40)) {
    if (retraceRatio(path.slice(i, j + 1), joinM * TOLERANZ_FAKTOR) >= retraceMin) return [i, j];
  }
  return null;
}

/**
 * Wie sehr decken sich zwei Routen? 0 = voellig verschieden, 1 = dieselbe.
 *
 * Gemittelt ueber beide Richtungen, damit eine kurze Route, die ganz auf
 * einer langen liegt, nicht als "gleich" durchgeht.
 */
export function similarity(a, b, toleranceM = 120, sampleM = 100) {
  const anteil = (x, y) => {
    const ziel = resample(y, sampleM);
    if (!ziel.length) return 0;
    const degLat = toleranceM / 111320;
    const degLonAt = (lat) => toleranceM / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
    const zellen = new Map();
    for (const p of ziel) {
      const key = `${Math.round(p[1] / degLat)}:${Math.round(p[0] / degLonAt(p[1]))}`;
      if (!zellen.has(key)) zellen.set(key, []);
      zellen.get(key).push(p);
    }
    const quelle = resample(x, sampleM);
    let treffer = 0;
    for (const p of quelle) {
      const row = Math.round(p[1] / degLat);
      const col = Math.round(p[0] / degLonAt(p[1]));
      let gefunden = false;
      for (let dr = -1; dr <= 1 && !gefunden; dr++) {
        for (let dc = -1; dc <= 1 && !gefunden; dc++) {
          for (const q of zellen.get(`${row + dr}:${col + dc}`) ?? []) {
            if (distance(p, q) <= toleranceM) {
              gefunden = true;
              break;
            }
          }
        }
      }
      if (gefunden) treffer++;
    }
    return quelle.length ? treffer / quelle.length : 0;
  };
  return (anteil(a, b) + anteil(b, a)) / 2;
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

/**
 * Liegt ein Punkt noch an der Route?
 *
 * Es reicht nicht, die Stuetzpunkte abzuklopfen: auf einer langen Geraden
 * koennen die hunderte Meter auseinanderliegen. Deshalb vorher auf feste
 * Schrittweite bringen.
 */
export function isNearPath(punkt, coords, toleranzM = 120, sampleM = 50) {
  for (const p of resample(coords, sampleM)) {
    if (distance(punkt, p) <= toleranzM) return true;
  }
  return false;
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
