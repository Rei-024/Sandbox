/**
 * Routing-Adapter.
 *
 * Beide Dienste liefern am Ende dasselbe Objekt zurueck (siehe RouteResult),
 * damit der Generator nichts ueber den konkreten Dienst wissen muss.
 *
 * RouteResult = {
 *   coords:      [[lon, lat, ele?], ...]
 *   distanceM:   number
 *   routerTimeS: number|null   -- Fahrzeitschaetzung des Dienstes (nur Referenz)
 *   ascentM:     number|null
 *   provider:    'brouter' | 'graphhopper'
 *   profileUsed: string
 * }
 */

const DEFAULT_TIMEOUT_MS = 25000;

export class RoutingError extends Error {
  /**
   * @param {string} message  Klartext fuer die Oberflaeche
   * @param {object} opts
   * @param {'unreachable'|'no-data'|'busy'|'profile'|'other'} [opts.kind]
   * @param {number|null} [opts.section]  betroffener Streckenabschnitt, falls bekannt
   */
  constructor(message, { provider, status, retryable = false, kind = 'other', section = null } = {}) {
    super(message);
    this.name = 'RoutingError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.kind = kind;
    this.section = section;
  }
}

/**
 * BRouter meldet fachliche Probleme als Klartext -- teils mit HTTP 400, teils
 * mit Status 200. Die Faelle, die sich beheben lassen, erkennen wir und geben
 * sie strukturiert weiter, statt dem Nutzer Servertext hinzuwerfen.
 */
export function classifyBRouterMessage(text) {
  const t = String(text ?? '');

  const island = t.match(/island detected for section\s+(\d+)/i);
  if (island) {
    return {
      kind: 'unreachable',
      section: Number(island[1]),
      message:
        'Ein Wegpunkt ist auf einem abgeschnittenen Stück Straßennetz gelandet (Waldweg, Insel, Sackgasse).',
    };
  }
  if (/position not mapped in existing datafile|datafile.*not found/i.test(t)) {
    return {
      kind: 'no-data',
      section: null,
      message: 'Für diese Gegend hat der BRouter-Server keine Kartendaten.',
    };
  }
  if (/no track found|not.*routable|unreachable|no route/i.test(t)) {
    return {
      kind: 'unreachable',
      section: null,
      message: 'Zwischen zwei Wegpunkten gibt es keine befahrbare Verbindung.',
    };
  }
  if (/watchdog|too many requests|server.*busy|timeout/i.test(t)) {
    return {
      kind: 'busy',
      section: null,
      message: 'Der öffentliche BRouter-Server ist gerade ausgelastet – gleich nochmal probieren.',
    };
  }
  if (/profile/i.test(t) && /unknown|not found|invalid/i.test(t)) {
    return { kind: 'profile', section: null, message: `BRouter kennt dieses Profil nicht: ${t}` };
  }
  return { kind: 'other', section: null, message: `BRouter: ${t}` };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outerSignal = options.signal;
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ BRouter */

/**
 * Profile, die der oeffentliche BRouter-Server kennt. "auto" waehlt anhand
 * der gewuenschten Kurvigkeit: fuer entspanntes Durchfahren das schnelle
 * Autoprofil, fuer kurvig das Eco-Profil, das grosse Schnellstrassen meidet
 * und lieber ueber Neben- und Landstrassen schickt.
 */
export const BROUTER_PROFILES = [
  { id: 'auto', label: 'Automatisch (nach Kurvigkeit)' },
  { id: 'car-eco', label: 'car-eco – meidet grosse Strassen' },
  { id: 'car-fast', label: 'car-fast – zuegig, grosse Strassen erlaubt' },
  { id: 'moped', label: 'moped – kleine Strassen, max. ~45 km/h Logik' },
  { id: 'shortest', label: 'shortest – kuerzeste Verbindung' },
];

const BROUTER_FALLBACK = 'car-fast';

export class BRouterAdapter {
  constructor({ baseUrl = 'https://brouter.de/brouter', profile = 'auto' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.profile = profile;
    this.provider = 'brouter';
  }

  get capabilities() {
    // BRouter nimmt ueber die URL nur einen Profilnamen entgegen -- die
    // Strassenwahl laesst sich also nur ueber das Profil steuern, nicht
    // punktgenau pro Anfrage.
    return {
      avoidMotorway: 'profile',
      avoidUnpaved: 'profile',
      avoidToll: 'waypoints-only',
      roundTrip: false,
      needsKey: false,
    };
  }

  resolveProfile(curviness) {
    if (this.profile !== 'auto') return this.profile;
    return curviness >= 3 ? 'car-eco' : 'car-fast';
  }

  async route(points, { curviness = 3, signal } = {}) {
    const profile = this.resolveProfile(curviness);
    try {
      return await this.#request(points, profile, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (profile !== BROUTER_FALLBACK && err.kind === 'profile') {
        // Unbekanntes Profil auf dem Server? Dann lieber mit dem Standard
        // weiterfahren als die ganze Generierung abzubrechen. Bei allen anderen
        // Fehlern waere ein zweiter Versuch nur eine verschwendete Anfrage.
        return this.#request(points, BROUTER_FALLBACK, signal);
      }
      throw err;
    }
  }

  async #request(points, profile, signal) {
    const lonlats = points.map((p) => `${round6(p[0])},${round6(p[1])}`).join('|');
    const url =
      `${this.baseUrl}?lonlats=${encodeURIComponent(lonlats)}` +
      `&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;

    let res;
    try {
      res = await fetchWithTimeout(url, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new RoutingError(
        'BRouter ist nicht erreichbar. Internetverbindung prüfen – oder in den Einstellungen einen eigenen BRouter-Server eintragen.',
        { provider: 'brouter', retryable: false },
      );
    }

    const body = await res.text();
    if (!res.ok) {
      const info = classifyBRouterMessage(trim(body));
      throw new RoutingError(info.message, {
        provider: 'brouter',
        status: res.status,
        retryable: info.kind === 'busy' || res.status >= 500,
        kind: info.kind,
        section: info.section,
      });
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      // BRouter meldet fachliche Fehler auch mal als Klartext mit Status 200.
      const info = classifyBRouterMessage(trim(body));
      throw new RoutingError(info.message, {
        provider: 'brouter',
        kind: info.kind,
        section: info.section,
        retryable: info.kind === 'busy',
      });
    }

    const feature = json?.features?.[0];
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new RoutingError('BRouter hat keine Route gefunden.', {
        provider: 'brouter',
        kind: 'unreachable',
      });
    }

    const props = feature.properties ?? {};
    return {
      coords,
      distanceM: num(props['track-length']) ?? 0,
      routerTimeS: num(props['total-time']),
      ascentM: num(props['filtered ascend']),
      provider: 'brouter',
      profileUsed: profile,
    };
  }
}

/* ------------------------------------------------------------- GraphHopper */

export class GraphHopperAdapter {
  constructor({ apiKey, baseUrl = 'https://graphhopper.com/api/1/route' } = {}) {
    this.apiKey = (apiKey ?? '').trim();
    this.baseUrl = baseUrl;
    this.provider = 'graphhopper';
  }

  get capabilities() {
    // Hier koennen wir per Custom-Model wirklich pro Anfrage steuern,
    // welche Strassenklassen bevorzugt oder gemieden werden -- und
    // GraphHopper bringt einen eigenen Rundkurs-Algorithmus mit.
    return {
      avoidMotorway: 'exact',
      avoidUnpaved: 'exact',
      avoidToll: 'exact',
      roundTrip: true,
      needsKey: true,
    };
  }

  /**
   * Rundkurs am Stueck: GraphHopper sucht selbst eine Schleife der
   * gewuenschten Laenge. Das umgeht unsere gewuerfelten Wegpunkte komplett --
   * und damit die Sackgassen und Stichstrassen, an denen sie im Gebirge
   * scheitern.
   */
  async roundTrip(start, distanceM, { seed = 1, curviness = 3, avoidMotorway = true, avoidUnpaved = true, avoidToll = true, signal } = {}) {
    return this.#post(
      {
        points: [[round6(start[0]), round6(start[1])]],
        profile: 'car',
        algorithm: 'round_trip',
        'round_trip.distance': Math.round(distanceM),
        'round_trip.seed': Math.round(seed),
        points_encoded: false,
        elevation: true,
        instructions: false,
        'ch.disable': true,
        custom_model: buildCustomModel(curviness, avoidMotorway, avoidUnpaved, avoidToll),
      },
      `car + round_trip (Kurvigkeit ${curviness})`,
      signal,
    );
  }

  async route(
    points,
    { curviness = 3, avoidMotorway = true, avoidUnpaved = true, avoidToll = true, signal } = {},
  ) {
    return this.#post(
      {
        points: points.map((p) => [round6(p[0]), round6(p[1])]),
        profile: 'car',
        points_encoded: false,
        elevation: true,
        instructions: false,
        calc_points: true,
        'ch.disable': true,
        custom_model: buildCustomModel(curviness, avoidMotorway, avoidUnpaved, avoidToll),
      },
      `car + custom_model (Kurvigkeit ${curviness})`,
      signal,
    );
  }

  async #post(payload, profileLabel, signal) {
    if (!this.apiKey) {
      throw new RoutingError(
        'Für GraphHopper fehlt der API-Key. Kostenlos auf graphhopper.com anlegen und in den Einstellungen eintragen.',
        { provider: 'graphhopper', retryable: false },
      );
    }

    let res;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        },
      );
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new RoutingError('GraphHopper ist nicht erreichbar.', {
        provider: 'graphhopper',
        retryable: false,
      });
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.message ?? `HTTP ${res.status}`;
      // GraphHopper benennt den unerreichbaren Punkt im hints-Block.
      const pointIndex = json?.hints?.find((h) => h.point_index != null)?.point_index;
      const unreachable = /connection between locations not found|cannot find point/i.test(msg);
      throw new RoutingError(
        unreachable ? 'Zwischen zwei Wegpunkten gibt es keine befahrbare Verbindung.' : `GraphHopper: ${msg}`,
        {
          provider: 'graphhopper',
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
          kind: unreachable ? 'unreachable' : 'other',
          section: pointIndex != null ? pointIndex + 1 : null,
        },
      );
    }

    const path = json?.paths?.[0];
    const coords = path?.points?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new RoutingError('GraphHopper hat keine Route gefunden.', {
        provider: 'graphhopper',
        kind: 'unreachable',
      });
    }

    return {
      coords,
      distanceM: path.distance ?? 0,
      routerTimeS: path.time != null ? path.time / 1000 : null,
      ascentM: path.ascend ?? null,
      provider: 'graphhopper',
      profileUsed: profileLabel,
    };
  }
}

/**
 * Custom-Model: Strassenklassen gewichten. `priority` ist ein Faktor auf die
 * "Attraktivitaet" einer Kante -- kleiner heisst, GraphHopper weicht aus.
 * Bewusst nie exakt 0, sonst kann eine Route unloesbar werden, wenn der
 * Startpunkt z.B. an einer Schotterzufahrt liegt.
 */
function buildCustomModel(curviness, avoidMotorway, avoidUnpaved, avoidToll = true) {
  const twisty = (curviness - 1) / 4; // 0 = egal, 1 = maximal kurvig
  const big = 1 - 0.85 * twisty; // grosse Strassen werden zunehmend unattraktiv
  const small = 1 + 0.8 * twisty; // kleine Strassen zunehmend attraktiv

  const priority = [
    { if: 'road_class == MOTORWAY', multiply_by: avoidMotorway ? 0.02 : big },
    { if: 'road_class == TRUNK', multiply_by: Math.max(0.05, big * 0.5) },
    { if: 'road_class == PRIMARY', multiply_by: Math.max(0.1, big) },
    { if: 'road_class == SECONDARY', multiply_by: 1 + 0.3 * twisty },
    { if: 'road_class == TERTIARY', multiply_by: small },
    { if: 'road_class == UNCLASSIFIED', multiply_by: 0.9 + 0.3 * twisty },
    { if: 'road_class == RESIDENTIAL', multiply_by: 0.55 },
    { if: 'road_class == LIVING_STREET', multiply_by: 0.2 },
    { if: 'road_class == TRACK || road_class == PATH', multiply_by: 0.02 },
    { if: 'road_environment == FERRY', multiply_by: 0.05 },
  ];
  if (avoidUnpaved) {
    priority.push({
      if: 'surface == GRAVEL || surface == DIRT || surface == SAND || surface == GROUND',
      multiply_by: 0.05,
    });
  }
  if (avoidToll) {
    priority.push({ if: 'toll == ALL || toll == HGV', multiply_by: 0.02 });
  }
  return { priority };
}

/* -------------------------------------------------------------- Geocoding */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
let lastNominatimCall = 0;

/** Nominatim erlaubt hoechstens eine Anfrage pro Sekunde. Daran halten wir uns. */
async function nominatimThrottle() {
  const wait = 1100 - (Date.now() - lastNominatimCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
}

/** Ortssuche. Liefert [{ label, point: [lon, lat] }]. */
export async function geocode(query, { signal, limit = 6 } = {}) {
  if (!query || query.trim().length < 2) return [];
  await nominatimThrottle();
  const url =
    `${NOMINATIM}/search?format=jsonv2&addressdetails=0&limit=${limit}` +
    `&accept-language=de&q=${encodeURIComponent(query.trim())}`;
  const res = await fetchWithTimeout(url, { signal }, 15000);
  if (!res.ok) throw new RoutingError(`Ortssuche fehlgeschlagen (HTTP ${res.status}).`);
  const json = await res.json();
  return json.map((hit) => ({
    label: hit.display_name,
    point: [Number(hit.lon), Number(hit.lat)],
  }));
}

/** Umgekehrte Suche: Wie heisst der Ort an diesen Koordinaten? */
export async function reverseGeocode(point, { signal } = {}) {
  await nominatimThrottle();
  const url =
    `${NOMINATIM}/reverse?format=jsonv2&zoom=12&accept-language=de` +
    `&lon=${round6(point[0])}&lat=${round6(point[1])}`;
  const res = await fetchWithTimeout(url, { signal }, 15000);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const a = json?.address ?? {};
  return (
    a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? json?.name ?? null
  );
}

/* --------------------------------------------------------------- Helferlein */

export function createRouter(settings) {
  if (settings.provider === 'graphhopper') {
    return new GraphHopperAdapter({ apiKey: settings.graphhopperKey });
  }
  return new BRouterAdapter({
    baseUrl: settings.brouterUrl || undefined,
    profile: settings.brouterProfile || 'auto',
  });
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const trim = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 220);
