/**
 * Kurvenjagd -- Oberflaeche und Ablaufsteuerung.
 *
 * Haelt den Zustand, verdrahtet Formular, Karte, Hoehenprofil und Export.
 * Die eigentliche Routenfindung steckt in generator.js, das Routing in
 * routers.js -- hier passiert nur Bedienung.
 */

import { clamp, cumulativeDistance, overlapPercent } from './geo.js';
import { generateRoutes, targetDistanceM } from './generator.js';
import {
  fetchRoadNetwork,
  networkCacheKey,
  snapWaypoints,
  tollNogos,
  tollRoadsNear,
} from './roads.js';
import { BROUTER_PROFILES, createRouter, geocode, reverseGeocode } from './routers.js';
import { MapView } from './mapview.js';
import { ElevationChart } from './elevation.js';
import { buildGpx, downloadText, googleMapsUrl, gpxFilename } from './export.js';
import { DEFAULTS, loadSettings, saveSettings } from './store.js';

const CURVINESS = [
  { value: 1, short: '1', label: 'Gerade & zügig', hint: 'Ankommen zählt. Schnelle Landstraßen, wenig Gekurbel.' },
  { value: 2, short: '2', label: 'Leicht geschwungen', hint: 'Normale Landstraße mit ein paar netten Bögen.' },
  { value: 3, short: '3', label: 'Schön kurvig', hint: 'Der Klassiker: Landstraße mit Schwung, gut fürs Gemüt.' },
  { value: 4, short: '4', label: 'Richtig kurvig', hint: 'Kleine Sträßchen, viel Kurbelei, wenig Geradeaus.' },
  { value: 5, short: '5', label: 'Serpentinen-Modus', hint: 'Maximal verwinkelt. Dauert länger, lohnt sich mehr.' },
];

const MODES = [
  { value: 'loop', label: 'Runde', hint: 'Endet wieder am Start.' },
  { value: 'oneway', label: 'Einwegstrecke', hint: 'Fährt weg vom Start – Rückweg planst du selbst.' },
];

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  candidates: [],
  selected: null,
  startLabel: '',
  endLabel: '',
  end: null,
  pickMode: null,
  controller: null,
  seed: Math.floor(Math.random() * 1e9),
};

let map;
let chart;
const roadCache = new Map();

/* ------------------------------------------------------------------ Start */

function init() {
  applyStoredTheme();
  buildSegmented($('curviness'), CURVINESS, 'curviness', (v) => setCurviness(Number(v)));
  buildSegmented($('mode'), MODES, 'mode', (v) => setMode(v));
  fillProfiles();

  map = new MapView($('map'), {
    onMapClick: handleMapClick,
    onStartDrag: (p) => setStart(p, null, { pan: false }),
    onEndDrag: (p) => setEnd(p, null),
    onCandidatePick: (id) => selectCandidate(id),
  });
  chart = new ElevationChart($('elevation'), { onHover: handleChartHover });

  restoreForm();
  wireEvents();

  if (state.settings.start) {
    setStart(state.settings.start, state.settings.startLabel, { pan: true });
  } else {
    locate({ silent: true });
  }
  map.invalidate();
}

function wireEvents() {
  $('route-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.seed = Math.floor(Math.random() * 1e9);
    run();
  });
  $('reroll-btn').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 1e9);
    run();
  });
  $('surprise-btn').addEventListener('click', surprise);
  $('locate-btn').addEventListener('click', () => locate({ silent: false }));

  $('duration').addEventListener('input', (e) => {
    state.settings.durationMin = Number(e.target.value);
    $('duration-out').textContent = formatDuration(state.settings.durationMin);
    persist();
  });
  $('bearing').addEventListener('change', (e) => {
    state.settings.bearing = e.target.value === '' ? null : Number(e.target.value);
    persist();
  });
  $('variant-count').addEventListener('change', (e) => {
    state.settings.variants = Number(e.target.value);
    persist();
  });
  $('avoid-motorway').addEventListener('change', (e) => {
    state.settings.avoidMotorway = e.target.checked;
    persist();
  });
  $('avoid-unpaved').addEventListener('change', (e) => {
    state.settings.avoidUnpaved = e.target.checked;
    persist();
  });
  $('avoid-toll').addEventListener('change', (e) => {
    state.settings.avoidToll = e.target.checked;
    persist();
  });
  $('snap-roads').addEventListener('change', (e) => {
    state.settings.snapToRoads = e.target.checked;
    persist();
  });
  $('provider').addEventListener('change', (e) => {
    state.settings.provider = e.target.value;
    updateProviderUi();
    persist();
  });
  $('brouter-profile').addEventListener('change', (e) => {
    state.settings.brouterProfile = e.target.value;
    persist();
  });
  // 'input' statt 'change': 'change' feuert erst beim Verlassen des Feldes.
  // Auf dem Handy heisst das: Key einfuegen, Tastatur schliessen, generieren --
  // und der Key war nie gespeichert.
  $('brouter-url').addEventListener('input', (e) => {
    state.settings.brouterUrl = e.target.value.trim();
    persist();
  });
  $('graphhopper-key').addEventListener('input', (e) => {
    state.settings.graphhopperKey = e.target.value.trim();
    persist();
  });
  $('ors-key').addEventListener('input', (e) => {
    state.settings.orsKey = e.target.value.trim();
    persist();
  });

  wireSearch($('start-input'), $('start-suggest'), (point, label) => setStart(point, label, { pan: true }));
  wireSearch($('end-input'), $('end-suggest'), (point, label) => setEnd(point, label));
  $('clear-end-btn').addEventListener('click', () => setEnd(null, ''));

  $('pick-start-btn').addEventListener('click', () => togglePick('start'));
  $('pick-end-btn').addEventListener('click', () => togglePick('end'));

  $('gpx-btn').addEventListener('click', downloadGpx);
  $('theme-toggle').addEventListener('click', toggleTheme);
}

/* ------------------------------------------------------- Formular / State */

function buildSegmented(container, options, name, onPick) {
  container.replaceChildren(
    ...options.map((opt) => {
      const id = `${name}-${opt.value}`;
      const input = Object.assign(document.createElement('input'), {
        type: 'radio',
        name,
        id,
        value: String(opt.value),
      });
      const label = Object.assign(document.createElement('label'), {
        htmlFor: id,
        title: opt.hint ?? '',
      });
      label.textContent = opt.short ?? opt.label;
      input.addEventListener('change', () => onPick(input.value));
      const wrap = document.createElement('div');
      wrap.className = 'segmented__item';
      wrap.append(input, label);
      return wrap;
    }),
  );
}

function fillProfiles() {
  $('brouter-profile').replaceChildren(
    ...BROUTER_PROFILES.map((p) => new Option(p.label, p.id)),
  );
}

function restoreForm() {
  const s = state.settings;
  $('duration').value = String(s.durationMin);
  $('duration-out').textContent = formatDuration(s.durationMin);
  $('bearing').value = s.bearing == null ? '' : String(s.bearing);
  $('variant-count').value = String(s.variants);
  $('avoid-motorway').checked = s.avoidMotorway;
  $('avoid-unpaved').checked = s.avoidUnpaved;
  $('avoid-toll').checked = s.avoidToll;
  $('snap-roads').checked = s.snapToRoads;
  $('provider').value = s.provider;
  $('brouter-profile').value = s.brouterProfile;
  $('brouter-url').value = s.brouterUrl;
  $('graphhopper-key').value = s.graphhopperKey;
  $('ors-key').value = s.orsKey;
  if (s.startLabel) $('start-input').value = s.startLabel;

  select('curviness', s.curviness);
  select('mode', s.mode);
  setCurviness(s.curviness);
  setMode(s.mode);
  updateProviderUi();
}

const select = (name, value) => {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

function setCurviness(value) {
  state.settings.curviness = value;
  const entry = CURVINESS.find((c) => c.value === value) ?? CURVINESS[2];
  $('curviness-hint').textContent = `${entry.label} – ${entry.hint}`;
  persist();
}

function setMode(value) {
  state.settings.mode = value;
  $('oneway-extra').hidden = value !== 'oneway';
  if (value === 'loop') map.setEnd(null);
  else if (state.end) map.setEnd(state.end);
  persist();
}

const PROVIDER_HINTS = {
  brouter:
    'BRouter kennt nur feste Profile: "Autobahn meiden" steuert die Profilwahl. ' +
    'Mautstraßen werden dagegen als Sperrzonen umfahren – dafür braucht es die ' +
    'Straßendaten oben, und wo es ohne Maut keinen Weg gibt, fällt die Sperre mit Hinweis weg.',
  openrouteservice:
    'OpenRouteService meidet Autobahn, Maut und Fähren exakt, und das schon im kostenlosen Tarif. ' +
    'Belagsfilter (Schotter) kennt es fürs Auto nicht.',
  graphhopper:
    'Achtung: GraphHopper braucht für Autobahn-/Maut-Meiden und die Rundkurs-Suche den flexiblen Modus, ' +
    'den der Gratis-Tarif nicht erlaubt. Dort bleibt nur schnellstes Autorouting – BRouter oder ' +
    'OpenRouteService sind dann die bessere Wahl.',
};

function updateProviderUi() {
  const p = state.settings.provider;
  $('brouter-options').hidden = p !== 'brouter';
  $('ors-options').hidden = p !== 'openrouteservice';
  $('graphhopper-options').hidden = p !== 'graphhopper';
  $('capability-hint').textContent = PROVIDER_HINTS[p] ?? '';
}

const persist = () => saveSettings(state.settings);

/* --------------------------------------------------------- Start und Ziel */

function setStart(point, label, { pan = false } = {}) {
  state.settings.start = point;
  map.setStart(point);
  if (pan) map.focus(point);
  if (label !== null && label !== undefined) {
    state.startLabel = label;
    state.settings.startLabel = label;
    $('start-input').value = label;
  } else {
    // Koordinaten, Kartenklick oder GPS: erst die Zahlen zeigen, den Ortsnamen
    // holen wir im Hintergrund nach.
    state.startLabel = '';
    state.settings.startLabel = '';
    $('start-input').value = formatPoint(point);
    nameStart();
  }
  persist();
}

function setEnd(point, label) {
  state.end = point;
  state.endLabel = label ?? '';
  map.setEnd(point);
  $('end-input').value = point ? (label || formatPoint(point)) : '';
}

function togglePick(which) {
  state.pickMode = state.pickMode === which ? null : which;
  $('pick-start-btn').setAttribute('aria-pressed', String(state.pickMode === 'start'));
  $('pick-end-btn').setAttribute('aria-pressed', String(state.pickMode === 'end'));
  setStatus(
    state.pickMode ? `Jetzt ${state.pickMode === 'start' ? 'den Start' : 'das Ziel'} auf der Karte antippen.` : '',
  );
}

function handleMapClick(point) {
  if (state.pickMode === 'end') {
    setEnd(point, null);
    togglePick('end');
  } else if (state.pickMode === 'start') {
    setStart(point, null);
    togglePick('start');
  }
}

async function locate({ silent }) {
  if (!navigator.geolocation) {
    if (!silent) showAlert('Dieser Browser kann keinen Standort ermitteln. Gib den Start bitte von Hand ein.');
    return;
  }
  setStatus('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStatus('');
      setStart([pos.coords.longitude, pos.coords.latitude], null, { pan: true });
      nameStart();
    },
    (err) => {
      setStatus('');
      if (!silent) {
        showAlert(
          err.code === err.PERMISSION_DENIED
            ? 'Standortfreigabe abgelehnt. Gib den Start bitte als Ort oder Adresse ein.'
            : 'Standort ließ sich nicht ermitteln. Gib den Start bitte von Hand ein.',
        );
      }
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

let nameStartToken = 0;

async function nameStart() {
  if (!state.settings.start) return;
  const token = ++nameStartToken;
  const point = state.settings.start;
  const name = await reverseGeocode(point).catch(() => null);
  // Zwischenzeitlich verschoben? Dann gilt das spaetere Ergebnis.
  if (token === nameStartToken && name) {
    state.startLabel = shortLabel(name);
    state.settings.startLabel = state.startLabel;
    $('start-input').value = state.startLabel;
    persist();
  }
}

/** Ortssuche mit Vorschlagsliste; Koordinateneingabe wird direkt erkannt. */
function wireSearch(input, list, onPick) {
  let timer;
  let controller;

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
  };

  const search = async () => {
    const q = input.value.trim();
    const coords = parseCoordinates(q);
    if (coords) {
      close();
      onPick(coords, null);
      return;
    }
    if (q.length < 3) return close();
    controller?.abort();
    controller = new AbortController();
    try {
      const hits = await geocode(q, { signal: controller.signal });
      if (!hits.length) return close();
      list.replaceChildren(
        ...hits.map((hit) => {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = hit.label;
          btn.addEventListener('click', () => {
            onPick(hit.point, shortLabel(hit.label));
            close();
          });
          li.append(btn);
          return li;
        }),
      );
      list.hidden = false;
    } catch (err) {
      if (err.name !== 'AbortError') close();
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 450);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      search();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 180));
}

/* ------------------------------------------------------------ Generierung */

async function run() {
  if (!state.settings.start) {
    showAlert('Erst den Start festlegen – Standortknopf, Suchfeld oder auf die Karte tippen.');
    return;
  }
  state.controller?.abort();
  state.controller = new AbortController();
  const { signal } = state.controller;

  hideAlert();
  setBusy(true);
  setStatus('Route wird gesucht …');

  const request = {
    start: state.settings.start,
    end: state.settings.mode === 'oneway' ? state.end : null,
    mode: state.settings.mode,
    durationMin: state.settings.durationMin,
    curviness: state.settings.curviness,
    bearing: state.settings.bearing,
    variants: state.settings.variants,
    avoidMotorway: state.settings.avoidMotorway,
    avoidUnpaved: state.settings.avoidUnpaved,
    avoidToll: state.settings.avoidToll,
    nogos: [],
    seed: state.seed,
  };

  const netzWarnungen = [];
  let snap = (waypoints) => waypoints;
  if (state.settings.snapToRoads) {
    try {
      const roads = await loadRoadNetwork(request, signal);
      state.roads = roads;
      // Overpass weiß, wo die Mautstraßen sind; BRouter weiß, wie man einen
      // Ort umfährt. Zusammen ergibt das echtes Maut-Meiden ohne zweiten
      // Dienst und ohne eine einzige zusätzliche Anfrage.
      if (request.avoidToll) {
        request.nogos = tollNogos(roads, { near: request.start });
      }
      snap = (waypoints) =>
        snapWaypoints(waypoints, roads, {
          curviness: request.curviness,
          avoidToll: request.avoidToll,
        });
    } catch (err) {
      if (err.name === 'AbortError') return;
      netzWarnungen.push(
        `Das Straßennetz ließ sich nicht laden (${err.message}) – die Wegpunkte werden blind gesetzt. ` +
          'Im Gebirge kommen dann eher Sackgassen heraus.',
      );
    }
  }

  const router = createRouter(state.settings);
  try {
    const { candidates, best, warnings } = await generateRoutes(request, {
      router,
      signal,
      snap,
      onProgress: ({ message }) => setStatus(`${message} …`),
    });
    state.candidates = candidates;
    showResult(best);
    if (matchMedia('(max-width: 899px)').matches) {
      $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const gewuenscht = state.settings.variants;
    setStatus(
      candidates.length < gewuenscht
        ? `${candidates.length} von ${gewuenscht} Varianten sind durchgekommen – die beste steht unten.`
        : `${candidates.length} Variante${candidates.length === 1 ? '' : 'n'} durchgerechnet – die beste steht unten.`,
    );
    const alle = [...netzWarnungen, ...warnings, ...(router.notices ?? []), ...mautHinweis(best)];
    if (alle.length) showAlert(alle.join(' '), 'warn');
    nameRoute(best);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus('');
    showAlert([err.message ?? 'Unbekannter Fehler bei der Routensuche.', ...(router.notices ?? [])].join(' '));
  } finally {
    setBusy(false);
  }
}

/**
 * Wir kennen von jeder Strasse nur einen Mittelpunkt, nicht ihren Verlauf --
 * daher ein Hinweis, keine Gewissheit. Lieber einmal zu oft gewarnt als den
 * Fahrer an eine Mautschranke schicken.
 */
function mautHinweis(candidate) {
  if (!state.settings.avoidToll || !state.roads?.length) return [];
  const namen = tollRoadsNear(candidate.coords, state.roads);
  if (!namen.length) return [];
  return [
    `Die Route führt möglicherweise über eine Mautstraße (${namen.slice(0, 3).join(', ')}). ` +
      'Die Sperrzonen greifen nur dort, wo die Straßendaten die Maut kennen.',
  ];
}

/**
 * Strassennetz der Gegend holen -- einmal je Suche, danach aus dem Speicher.
 * Der Suchradius richtet sich nach der geplanten Rundengroesse: alles enger
 * waere nutzlos, alles weiter nur Ballast.
 */
async function loadRoadNetwork(request, signal) {
  const ring = targetDistanceM(request.durationMin, request.curviness) / (2 * Math.PI * 1.25);
  const radius = clamp(ring * 1.7, 6000, 45000);
  const key = networkCacheKey(request.start, radius);

  if (roadCache.has(key)) return roadCache.get(key);
  setStatus('Straßennetz der Gegend laden …');
  const roads = await fetchRoadNetwork(request.start, radius, { signal });
  roadCache.set(key, roads);
  return roads;
}

function surprise() {
  const rnd = (min, max) => min + Math.random() * (max - min);
  const duration = Math.round(rnd(60, 300) / 15) * 15;
  const curviness = 3 + Math.floor(Math.random() * 3);
  $('duration').value = String(duration);
  $('duration-out').textContent = formatDuration(duration);
  state.settings.durationMin = duration;
  select('curviness', curviness);
  setCurviness(curviness);
  const bearing = Math.floor(Math.random() * 8) * 45;
  $('bearing').value = String(bearing);
  state.settings.bearing = bearing;
  state.seed = Math.floor(Math.random() * 1e9);
  persist();
  run();
}

/* -------------------------------------------------------------- Ausgabe */

function showResult(candidate) {
  state.selected = candidate;
  $('placeholder').hidden = true;
  $('result').hidden = false;

  map.showRoute(candidate, state.candidates);
  renderStats(candidate);
  renderVariants();
  renderElevation(candidate);

  $('gmaps-btn').href = googleMapsUrl(candidate);
  $('route-sub').textContent = describe(candidate);
  $('export-hint').textContent =
    'Die GPX-Datei enthält den exakten Verlauf. Der Google-Maps-Link nutzt nur wenige Zwischenziele – Google routet dazwischen selbst.';
  $('route-name').textContent = defaultName(candidate);
}

function renderStats(c) {
  const km = c.distanceM / 1000;
  const level = c.curvinessLevel;
  const ascent = c.elevation?.ascent ?? c.ascentM ?? 0;

  $('stats').replaceChildren(
    statTile('Strecke', km.toFixed(km < 100 ? 1 : 0), 'km'),
    statTile('Fahrzeit', formatDuration(c.durationMin), '', `Ø ${Math.round(c.speedKmh)} km/h`),
    curvinessTile(level, c.curvature.degPerKm),
    statTile('Bergauf', Math.round(ascent).toLocaleString('de-DE'), 'Hm', `${Math.round(c.elevation?.max ?? 0)} m höchster Punkt`),
  );
}

function statTile(label, value, unit, note) {
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = `
    <span class="stat__label">${escapeHtml(label)}</span>
    <span class="stat__value">${escapeHtml(value)}${unit ? `<span class="stat__unit">${escapeHtml(unit)}</span>` : ''}</span>
    ${note ? `<span class="stat__note">${escapeHtml(note)}</span>` : ''}`;
  return el;
}

function curvinessTile(level, degPerKm) {
  const el = document.createElement('div');
  el.className = 'stat';
  const filled = Math.round(level);
  const segments = Array.from(
    { length: 5 },
    (_, i) => `<span class="meter__seg${i < filled ? ' is-on' : ''}"></span>`,
  ).join('');
  el.innerHTML = `
    <span class="stat__label">Kurvigkeit</span>
    <span class="stat__value">${level.toFixed(1)}<span class="stat__unit">von 5</span></span>
    <span class="meter" role="img" aria-label="Kurvigkeit ${level.toFixed(1)} von 5">${segments}</span>
    <span class="stat__note">${Math.round(degPerKm)}° Richtungswechsel je km</span>`;
  return el;
}

function renderVariants() {
  const box = $('route-variants');
  if (state.candidates.length < 2) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    ...state.candidates.map((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chip${c.id === state.selected?.id ? ' is-active' : ''}`;
      btn.setAttribute('aria-pressed', String(c.id === state.selected?.id));
      btn.innerHTML = `<strong>Variante ${c.rank}</strong><span>${Math.round(c.distanceM / 1000)} km · ${formatDuration(
        c.durationMin,
      )} · ${c.curvinessLevel.toFixed(1)}/5</span>`;
      btn.addEventListener('click', () => selectCandidate(c.id));
      return btn;
    }),
  );
}

function selectCandidate(id) {
  const candidate = state.candidates.find((c) => c.id === id);
  if (candidate) {
    showResult(candidate);
    nameRoute(candidate);
  }
}

function renderElevation(candidate) {
  const cum = cumulativeDistance(candidate.coords);
  const ok = chart.setData(candidate.coords, cum);
  candidate.cumulative = cum;
  const section = $('elevation').closest('.card');
  section.hidden = !ok;
  if (!ok) return;

  const tbody = $('elevation-table').querySelector('tbody');
  tbody.replaceChildren(
    ...chart.tableRows().map((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.km.toFixed(1)}</td><td>${Math.round(row.ele)} m</td><td>${
        row.slope ? `${row.slope > 0 ? '+' : ''}${row.slope.toFixed(1)} %` : '–'
      }</td>`;
      return tr;
    }),
  );
}

function handleChartHover(index) {
  if (index == null || !state.selected) return map.hoverAt(null);
  map.hoverAt(state.selected.coords[index]);
}

async function nameRoute(candidate) {
  const startName = state.startLabel || (await reverseGeocode(candidate.coords[0]).catch(() => null));
  if (startName && !state.startLabel) {
    state.startLabel = shortLabel(startName);
    $('start-input').value = state.startLabel;
  }
  if (state.settings.mode === 'loop') {
    $('route-name').textContent = startName ? `Runde ab ${shortLabel(startName)}` : defaultName(candidate);
    return;
  }
  const endPoint = candidate.coords[candidate.coords.length - 1];
  const endName = state.endLabel || (await reverseGeocode(endPoint).catch(() => null));
  $('route-name').textContent =
    startName && endName ? `Von ${shortLabel(startName)} nach ${shortLabel(endName)}` : defaultName(candidate);
}

const defaultName = (c) =>
  state.settings.mode === 'loop'
    ? `Runde über ${Math.round(c.distanceM / 1000)} km`
    : `Strecke über ${Math.round(c.distanceM / 1000)} km`;

function describe(c) {
  const parts = [
    `${state.settings.mode === 'loop' ? 'Rundkurs' : 'Einwegstrecke'}`,
    `angepeilt waren ${formatDuration(state.settings.durationMin)}`,
  ];
  // Die gemessene Kurvigkeit ist das, was die Strassen hergeben -- nicht das,
  // was angeklickt wurde. Auseinanderlaufen darf das, verschwiegen wird es nicht.
  // Die Wunschzeit deutlich verfehlt? Das gehoert in die erste Zeile, nicht
  // versteckt in die Kennzahl darunter.
  const zeitAbweichung = (c.durationMin - state.settings.durationMin) / state.settings.durationMin;
  if (zeitAbweichung > 0.25) parts.push('kürzer war hier keine Runde zu finden');
  else if (zeitAbweichung < -0.25) parts.push('länger gab die Gegend nicht her');

  const delta = c.curvinessLevel - state.settings.curviness;
  if (delta <= -0.8) parts.push('kurviger gab die Gegend nicht her');
  else if (delta >= 0.8) parts.push('kurviger geworden als bestellt');
  if (c.spurCuts > 0) {
    parts.push(
      `${c.spurCuts} Sackgassen-${c.spurCuts === 1 ? 'Ast' : 'Äste'} entfernt ` +
        `(${(c.spursRemovedM / 1000).toFixed(1)} km)`,
    );
  }
  if (c.curvature.hairpins > 3) parts.push(`${c.curvature.hairpins} enge Kehren`);
  // Doppelt gefahrene Strecke ist der ehrlichste Qualitaetsindikator einer
  // Runde -- lieber die Zahl zeigen als sie zu umschreiben.
  const doppelt = overlapPercent(c.overlap);
  if (doppelt >= 8) parts.push(`${doppelt} % doppelt gefahren`);
  parts.push(`Routing: ${c.provider === 'brouter' ? 'BRouter' : 'GraphHopper'} (${c.profileUsed})`);
  return parts.join(' · ');
}

function downloadGpx() {
  const c = state.selected;
  if (!c) return;
  const name = $('route-name').textContent.trim() || 'Motorradrunde';
  const gpx = buildGpx(c, {
    name,
    description: `${(c.distanceM / 1000).toFixed(1)} km, ca. ${formatDuration(
      c.durationMin,
    )}, Kurvigkeit ${c.curvinessLevel.toFixed(1)}/5 – erzeugt mit Kurvenjagd.`,
  });
  downloadText(gpxFilename(name), gpx);
}

/* ------------------------------------------------------------- Kleinkram */

function setBusy(busy) {
  $('generate-btn').disabled = busy;
  $('surprise-btn').disabled = busy;
  $('reroll-btn').disabled = busy;
  $('generate-btn').textContent = busy ? 'Suche läuft …' : 'Strecke generieren';
  document.body.classList.toggle('is-busy', busy);
}

const setStatus = (text) => {
  $('status').textContent = text;
};

function showAlert(message, kind = 'error') {
  const el = $('alert');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

const hideAlert = () => {
  $('alert').hidden = true;
};

export function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** "48.4636, 8.4117" oder "48.4636 8.4117" -> [lon, lat] */
export function parseCoordinates(text) {
  const m = text.match(/^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lon = Number(m[2].replace(',', '.'));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

export const formatPoint = (p) => `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`;

/** Aus "Freudenstadt, Landkreis ..., Deutschland" wird "Freudenstadt". */
export function shortLabel(label) {
  return String(label).split(',')[0].trim();
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/* --------------------------------------------------------------- Theming */

function applyStoredTheme() {
  const stored = localStorage.getItem('kurvenjagd.theme');
  if (stored) document.documentElement.dataset.theme = stored;
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('kurvenjagd.theme', next);
}

if (typeof document !== 'undefined' && document.getElementById('route-form')) {
  init();
}

export { DEFAULTS };
