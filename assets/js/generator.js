/**
 * Routen-Generator.
 *
 * Idee: Einen Router zu bitten "gib mir eine schoene kurvige Runde" geht
 * nicht -- Router verbinden Punkte. Also erzeugen wir die Punkte selbst:
 *
 *  1. Aus Wunschdauer und Wunschkurvigkeit eine Ziel-Streckenlaenge schaetzen.
 *  2. Wegpunkte auf einen Ring um den Start legen (Runde) bzw. seitlich
 *     versetzt in Fahrtrichtung (Einwegstrecke).
 *  3. Routen lassen, das Ergebnis *nachmessen* (Laenge, echte Kurvigkeit,
 *     Hoehenmeter, Doppeltfahren) und den Ring nachjustieren.
 *  4. Das Ganze mehrfach mit anderen Startwinkeln -- und am Ende die Variante
 *     nehmen, die am besten zum Wunsch passt.
 *
 * Schritt 3 ist der Trick: die Kurvigkeit wird nicht versprochen, sondern
 * an der fertigen Geometrie gemessen.
 */

import {
  clamp,
  curvature,
  degPerKmToLevel,
  destination,
  distance,
  elevationStats,
  estimateSpeedKmh,
  levelToDegPerKm,
  overlapDetail,
} from './geo.js';

const MAX_ITERATIONS = 3; // Routing-Anfragen je Variante
const TIME_TOLERANCE = 0.1; // 10 % Abweichung sind gut genug
const REQUEST_GAP_MS = 350; // schont die oeffentlichen Server
const MAX_REPAIRS_TOTAL = 12; // Zusatzanfragen fuer unerreichbare Wegpunkte, je Suche
const MAX_REPAIRS_PER_VARIANT = 4; // damit ein zaeher Fall nicht alle Varianten auffrisst
const MAX_REPAIRS_PER_CALL = 3;
const MAX_TRIES_PER_VARIANT = 4; // Routing-Anfragen je Variante, ohne Reparaturen
const SPUR_LIMIT = 0.12; // ab hier lohnt es, gegen Stichstrassen vorzugehen
const MAX_SPUR_FIXES = 2;

/** Kleiner deterministischer Zufallsgenerator, damit "neu wuerfeln" reproduzierbar ist. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fahrzeit und Kennzahlen einer fertigen Route aus ihrer Geometrie ableiten. */
export function measure(route) {
  const curv = curvature(route.coords);
  const elevation = elevationStats(route.coords);
  const km = route.distanceM / 1000;
  const ascentM = elevation?.ascent ?? route.ascentM ?? 0;
  const ascentPerKm = km > 0 ? ascentM / km : 0;
  const speedKmh = estimateSpeedKmh(curv.degPerKm, ascentPerKm);
  return {
    curvature: curv,
    curvinessLevel: degPerKmToLevel(curv.degPerKm),
    elevation,
    speedKmh,
    durationMin: km > 0 ? (km / speedKmh) * 60 : 0,
    overlap: overlapDetail(route.coords).ratio,
  };
}

/**
 * Kleiner ist besser. Doppelt gefahrene Strecke wiegt bei einer Runde schwer:
 * eine Runde, die als Stern aus Stichstrassen herauskommt, ist keine Runde --
 * lieber eine, die die Wunschzeit um zwanzig Minuten verfehlt.
 */
function scoreCandidate(m, request) {
  const timeErr = Math.abs(m.durationMin - request.durationMin) / request.durationMin;
  const curvErr = Math.abs(m.curvinessLevel - request.curviness) / 4;
  const overlapWeight = request.mode === 'loop' ? 1.8 : 0.8;
  const uTurnPenalty = Math.min(0.3, m.curvature.uTurns * 0.04);
  return timeErr + 0.7 * curvErr + overlapWeight * m.overlap + uTurnPenalty;
}

/** Wunschdauer -> anzupeilende Streckenlaenge in Metern. */
export function targetDistanceM(durationMin, curviness) {
  const speed = estimateSpeedKmh(levelToDegPerKm(curviness));
  return (durationMin / 60) * speed * 1000;
}

/**
 * Wegpunkte auf einem Ring um den Start.
 *
 * Mehr Wegpunkte = der Router muss oefter vom schnellen Hauptweg abbiegen,
 * das ist der wirksamste Hebel fuer Kurvigkeit. Bei hoher Wunschkurvigkeit
 * wechseln die Radien ausserdem zwischen "weiter aussen" und "weiter innen",
 * damit die Route sich durchs Gelaende schlaengelt statt brav im Kreis zu
 * fahren.
 */
function ringWaypoints(start, radiusM, curviness, bearing0, rng) {
  const twisty = (curviness - 1) / 4;
  const count = 4 + Math.round(curviness); // 5 .. 9
  const angleJitter = (360 / count) * (0.15 + 0.25 * twisty);
  const radialJitter = 0.12 + 0.3 * twisty;
  const points = [];
  for (let i = 0; i < count; i++) {
    const weave = twisty > 0.4 ? (i % 2 === 0 ? 1.12 : 0.84) : 1;
    const angle = bearing0 + (360 * i) / count + (rng() - 0.5) * 2 * angleJitter;
    const radius = radiusM * weave * (1 + (rng() - 0.5) * 2 * radialJitter);
    points.push(destination(start, angle, Math.max(500, radius)));
  }
  return points;
}

/** Zwischenpunkte fuer eine Einwegstrecke: abwechselnd links/rechts der Luftlinie. */
function detourWaypoints(start, end, amplitudeM, curviness, rng) {
  const count = 1 + Math.round(curviness * 0.8); // 2 .. 5
  const direct = distance(start, end);
  const points = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const base = [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ];
    const side = i % 2 === 0 ? 90 : -90;
    const heading = bearingBetween(start, end);
    const amp = amplitudeM * (0.6 + 0.8 * rng()) * Math.sin(Math.PI * t);
    points.push(destination(base, heading + side, Math.min(amp, direct * 0.6)));
  }
  return points;
}

/**
 * Wegpunkte verschieben, nachdem der Router einen davon nicht erreichen konnte.
 *
 * Gezogen wird Richtung Start: dort steht der Fahrer, dort ist das Netz also
 * nachweislich befahrbar -- das ist ein deutlich besserer Tipp als eine
 * zufaellige Richtung, die den Punkt genauso gut tiefer in den Wald setzt.
 * Etwas Streuung kommt dazu, damit zwei Versuche nicht dieselbe Stelle treffen.
 *
 * Der Router nennt den betroffenen Abschnitt, aber ob er dabei ab null oder ab
 * eins zaehlt, ist nicht verlaesslich -- deshalb wandern der Verdaechtige und
 * seine beiden Nachbarn. Alle uebrigen bleiben liegen: wer schon erreichbar
 * war, soll nicht versehentlich auf die naechste Insel geschoben werden.
 *
 * Dass die Route dabei anders wird, ist kein Verlust: sie war ohnehin gewuerfelt.
 */
export function nudgeWaypoints(waypoints, section, attempt, rng, anchor) {
  const suspect = section == null ? -1 : clamp(section - 1, 0, waypoints.length - 1);
  return waypoints.map((wp, i) => {
    const affected = suspect < 0 || Math.abs(i - suspect) <= 1;
    if (!affected) return wp;
    const pull = 0.25 + 0.2 * attempt + 0.15 * rng();
    const inward = destination(wp, bearingBetween(wp, anchor), distance(wp, anchor) * pull);
    return destination(inward, rng() * 360, 400 + 600 * rng());
  });
}

/**
 * Welcher Wegpunkt hat die Stichstrasse verursacht?
 *
 * Ein Wegpunkt in einem Sackgassental zwingt den Router hinein und auf
 * demselben Weg wieder heraus. Die doppelt befahrenen Punkte haeufen sich
 * dann rund um diesen Wegpunkt -- wer die meisten davon in seiner Naehe hat,
 * ist der Schuldige.
 */
export function spurCulprit(waypoints, repeated, radiusM = 3000) {
  let best = -1;
  let bestCount = 0;
  waypoints.forEach((wp, i) => {
    let n = 0;
    for (const p of repeated) if (distance(p, wp) < radiusM) n++;
    if (n > bestCount) {
      bestCount = n;
      best = i;
    }
  });
  return bestCount >= 3 ? best : -1;
}

/**
 * Den Wegpunkt auf dem Ring weiterdrehen: gleicher Abstand zum Start, anderes
 * Tal. Das haelt die Streckenlaenge stabil und holt den Punkt trotzdem aus der
 * Sackgasse heraus.
 */
export function rotateWaypoint(waypoints, index, start, rng) {
  const wp = waypoints[index];
  const radius = distance(start, wp);
  const turn = (rng() < 0.5 ? -1 : 1) * (25 + 35 * rng());
  const moved = destination(start, bearingBetween(start, wp) + turn, radius);
  return waypoints.map((p, i) => (i === index ? moved : p));
}

/** Letzter Ausweg: den verdaechtigen Wegpunkt ganz weglassen. */
export function dropWaypoint(waypoints, section) {
  if (waypoints.length <= 1) return null;
  const idx =
    section == null
      ? Math.floor(waypoints.length / 2)
      : clamp(section - 1, 0, waypoints.length - 1);
  return waypoints.filter((_, i) => i !== idx);
}

/**
 * Routet und repariert dabei Wegpunkte, die der Router nicht erreicht.
 * Zweimal verschieben, danach weglassen -- alles aus einem gemeinsamen
 * Anfragebudget, damit ein zaeher Fall nicht den oeffentlichen Server flutet.
 */
async function routeWithRepair({ waypoints, assemble, anchor, call, rng, budget }) {
  let current = waypoints.slice();
  let attempt = 0;

  for (;;) {
    try {
      return { route: await call(assemble(current)), waypoints: current };
    } catch (err) {
      const fixable = err.name !== 'AbortError' && err.kind === 'unreachable';
      if (!fixable || budget.left <= 0 || attempt >= MAX_REPAIRS_PER_CALL) throw err;
      budget.left--;
      attempt++;

      // Einmal verschieben -- danach lieber weglassen. Weglassen wirkt
      // zuverlaessig, und bei fuenf bis neun Wegpunkten faellt einer weniger
      // kaum auf.
      if (attempt === 1) {
        current = nudgeWaypoints(current, err.section, attempt, rng, anchor);
        continue;
      }
      const reduced = dropWaypoint(current, err.section);
      if (!reduced) throw err;
      current = reduced;
    }
  }
}

function bearingBetween(a, b) {
  // Eigene kleine Variante, um den Import klein zu halten.
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Eine komplette Generierung.
 *
 * @param {object} request  siehe unten
 * @param {object} deps     { router, onProgress, signal }
 * @returns {Promise<{candidates: object[], best: object, warnings: string[]}>}
 */
export async function generateRoutes(
  request,
  { router, onProgress = () => {}, signal, requestGapMs = REQUEST_GAP_MS } = {},
) {
  const {
    start,
    end = null,
    mode = 'loop',
    durationMin = 120,
    curviness = 3,
    bearing = null,
    variants = 3,
    avoidMotorway = true,
    avoidUnpaved = true,
    seed = Math.floor(Math.random() * 1e9),
  } = request;

  const normalized = { ...request, mode, durationMin, curviness, variants };
  const candidates = [];
  const failures = [];
  const pool = { left: MAX_REPAIRS_TOTAL };
  let lastError = null;
  let requestCount = 0;

  const call = async (points) => {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    if (requestCount > 0 && requestGapMs > 0) await sleep(requestGapMs);
    requestCount++;
    return router.route(points, { curviness, avoidMotorway, avoidUnpaved, signal });
  };

  for (let v = 0; v < variants; v++) {
    const rng = mulberry32(seed + v * 7919);
    const bearing0 = bearing != null ? bearing + (v * 360) / variants : rng() * 360;
    // Jede Variante bekommt ihren eigenen Reparaturvorrat, sonst frisst die
    // erste in unwegsamem Gelaende alles auf und die anderen fallen aus.
    const budget = { left: Math.min(pool.left, MAX_REPAIRS_PER_VARIANT) };
    const granted = budget.left;

    try {
      const produced =
        mode === 'loop'
          ? await buildLoop({ start, bearing0, rng, normalized, call, onProgress, v, variants, budget })
          : await buildOneWay({
              start,
              end,
              bearing0,
              rng,
              normalized,
              call,
              onProgress,
              v,
              variants,
              failures,
              budget,
            });
      candidates.push(...produced);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      failures.push({ variant: v + 1, message: err.message });
    } finally {
      pool.left -= granted - budget.left;
    }
  }

  if (!candidates.length) {
    throw explain(lastError);
  }

  // Beim Nachjustieren entstehen je Variante mehrere Routen. Alle zu zeigen
  // waere Augenwischerei -- sie unterscheiden sich kaum und widersprechen der
  // Einstellung "wie viele Varianten". Also je Variante die beste behalten.
  const shortlist = bestPerVariant(candidates);
  shortlist.sort((a, b) => a.score - b.score);
  shortlist.forEach((c, i) => {
    c.rank = i + 1;
  });
  return {
    candidates: shortlist,
    best: shortlist[0],
    attempts: candidates.length,
    warnings: summarize(failures),
  };
}

/**
 * Gleiche Fehler zusammenfassen -- dreimal derselbe Satz untereinander liest
 * sich wie ein Totalausfall, obwohl es dieselbe Ursache ist.
 */
function summarize(failures) {
  const byMessage = new Map();
  for (const f of failures) {
    if (!byMessage.has(f.message)) byMessage.set(f.message, []);
    byMessage.get(f.message).push(f.variant);
  }
  return [...byMessage].map(([message, variants]) => {
    const list =
      variants.length === 1
        ? `Variante ${variants[0]}`
        : `Varianten ${variants.slice(0, -1).join(', ')} und ${variants[variants.length - 1]}`;
    return `${list}: ${message}`;
  });
}

/**
 * Wenn gar nichts durchkam: dem Nutzer sagen, was er tun kann, statt ihm den
 * Servertext hinzuwerfen. Ein neuer Anlauf wuerfelt andere Wegpunkte und hilft
 * bei einem Inselproblem meistens schon.
 */
function explain(lastError) {
  if (!lastError) return new Error('Es ließ sich keine Route erzeugen.');
  if (lastError.kind === 'unreachable') {
    return new Error(
      `${lastError.message} Tipp nochmal auf »Strecke generieren« – dann werden andere ` +
        'Wegpunkte gewürfelt. Hilft das nicht, verschieb die Start-Nadel auf eine größere Straße.',
    );
  }
  return lastError;
}

/** Aus allen Versuchen je Startwinkel den besten herausziehen. */
function bestPerVariant(candidates) {
  const byVariant = new Map();
  for (const c of candidates) {
    const key = c.seedBearing?.toFixed(3) ?? String(byVariant.size);
    const current = byVariant.get(key);
    if (!current || c.score < current.score) byVariant.set(key, c);
  }
  return [...byVariant.values()];
}

async function buildLoop({ start, bearing0, rng, normalized, call, onProgress, v, variants, budget }) {
  const { durationMin, curviness } = normalized;
  const twisty = (curviness - 1) / 4;
  const detour = 1.15 + 0.22 * twisty; // Strassen sind laenger als der Idealkreis
  let radius = targetDistanceM(durationMin, curviness) / (2 * Math.PI * detour);

  let waypoints = ringWaypoints(start, radius, curviness, bearing0, rng);
  let spurFixes = 0;
  const out = [];

  for (let iter = 0; iter < MAX_TRIES_PER_VARIANT; iter++) {
    onProgress({
      variant: v + 1,
      variants,
      attempt: iter + 1,
      message: `Variante ${v + 1}/${variants} – Versuch ${iter + 1}`,
    });

    const { route, waypoints: used } = await routeWithRepair({
      waypoints,
      assemble: (wps) => [start, ...wps, start],
      anchor: start,
      call,
      rng,
      budget,
    });
    waypoints = used;
    const candidate = finalize(route, used, normalized, { seedBearing: bearing0 });
    out.push(candidate);

    const ratio = durationMin / Math.max(1, candidate.durationMin);
    const timeOk = Math.abs(1 - ratio) <= TIME_TOLERANCE;
    const spurOk = candidate.overlap <= SPUR_LIMIT;
    if (timeOk && spurOk) break;

    // Erst die Zeit treffen -- eine Route, die eine Stunde danebenliegt,
    // muss man nicht auf Stichstrassen abklopfen.
    if (!timeOk) {
      radius *= clamp(ratio, 0.6, 1.7) ** 0.9;
      waypoints = ringWaypoints(start, radius, curviness, bearing0, rng);
      continue;
    }

    if (spurFixes >= MAX_SPUR_FIXES) break;
    const culprit = spurCulprit(waypoints, overlapDetail(route.coords).repeated);
    if (culprit < 0) break; // kein einzelner Schuldiger -- die Gegend gibt es nicht her
    onProgress({
      variant: v + 1,
      variants,
      attempt: iter + 1,
      message: `Variante ${v + 1}/${variants} – Stichstrasse umgehen`,
    });
    // Erst versetzen, dann streichen.
    const fixed =
      spurFixes === 0
        ? rotateWaypoint(waypoints, culprit, start, rng)
        : dropWaypoint(waypoints, culprit + 1);
    if (!fixed) break;
    waypoints = fixed;
    spurFixes++;
  }
  return out;
}

async function buildOneWay({
  start,
  end,
  bearing0,
  rng,
  normalized,
  call,
  onProgress,
  v,
  variants,
  failures,
  budget,
}) {
  const { durationMin, curviness } = normalized;
  const twisty = (curviness - 1) / 4;
  const out = [];

  if (end) {
    // Ziel vorgegeben: erst die direkte Verbindung messen, dann so viel
    // Umweg einbauen, dass die Wunschdauer hinkommt.
    onProgress({ variant: v + 1, variants, attempt: 1, message: 'Direkte Verbindung pruefen' });
    const direct = await call([start, end]);
    const directCandidate = finalize(direct, [], normalized, { seedBearing: bearing0 });
    out.push(directCandidate);

    if (directCandidate.durationMin > durationMin * (1 + TIME_TOLERANCE)) {
      if (v === 0) {
        failures.push({
          variant: v + 1,
          message: `Die direkte Strecke zum Ziel dauert schon rund ${Math.round(
            directCandidate.durationMin,
          )} min – kürzer als die Wunschdauer geht es nicht.`,
        });
      }
      return out;
    }

    let amplitude = distance(start, end) * 0.18 * (1 + twisty);
    for (let iter = 1; iter < MAX_ITERATIONS + 1; iter++) {
      onProgress({
        variant: v + 1,
        variants,
        attempt: iter + 1,
        message: `Variante ${v + 1}/${variants} – Umweg justieren`,
      });
      const { route, waypoints: used } = await routeWithRepair({
        waypoints: detourWaypoints(start, end, amplitude, curviness, rng),
        assemble: (wps) => [start, ...wps, end],
        anchor: start,
        call,
        rng,
        budget,
      });
      const candidate = finalize(route, used, normalized, { seedBearing: bearing0 });
      out.push(candidate);

      if (Math.abs(candidate.durationMin - durationMin) / durationMin <= TIME_TOLERANCE) break;
      const needExtra = durationMin - directCandidate.durationMin;
      const haveExtra = candidate.durationMin - directCandidate.durationMin;
      amplitude *= clamp(needExtra / Math.max(haveExtra, 1), 0.4, 2.2) ** 0.9;
    }
    return out;
  }

  // Kein Ziel: Richtung waehlen und einen Endpunkt in passender Entfernung setzen.
  const detour = 1.2 + 0.25 * twisty;
  let reach = targetDistanceM(durationMin, curviness) / detour;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    onProgress({
      variant: v + 1,
      variants,
      attempt: iter + 1,
      message: `Variante ${v + 1}/${variants} – Versuch ${iter + 1}`,
    });
    const target = destination(start, bearing0, Math.max(2000, reach));
    const { route, waypoints: used } = await routeWithRepair({
      waypoints: detourWaypoints(start, target, reach * 0.22 * (1 + twisty), curviness, rng),
      assemble: (wps) => [start, ...wps, target],
      anchor: start,
      call,
      rng,
      budget,
    });
    const candidate = finalize(route, [...used, target], normalized, {
      seedBearing: bearing0,
    });
    out.push(candidate);

    const ratio = durationMin / Math.max(1, candidate.durationMin);
    if (Math.abs(1 - ratio) <= TIME_TOLERANCE) break;
    reach *= clamp(ratio, 0.6, 1.7) ** 0.9;
  }
  return out;
}

let candidateId = 0;

function finalize(route, waypoints, request, extra = {}) {
  const m = measure(route);
  return {
    id: `route-${++candidateId}`,
    coords: route.coords,
    distanceM: route.distanceM,
    routerTimeS: route.routerTimeS,
    provider: route.provider,
    profileUsed: route.profileUsed,
    waypoints,
    ...m,
    ...extra,
    score: scoreCandidate(m, request),
  };
}
