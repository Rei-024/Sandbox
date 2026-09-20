/** GPX-Export und Navi-Links. */

import { sampleAlong, simplify } from './geo.js';

const APP = 'Kurvenjagd';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const c6 = (v) => v.toFixed(6);

/**
 * GPX 1.1 mit einem Track (die gefahrene Linie) und Wegpunkten fuer Start,
 * Ziel und die Stuetzpunkte. Das lesen Kurviger, Calimoto, OsmAnd, Garmin
 * und so ziemlich alles andere.
 */
export function buildGpx(route, { name = 'Motorradrunde', description = '' } = {}) {
  const now = new Date().toISOString();
  const coords = route.coords;
  const first = coords[0];
  const last = coords[coords.length - 1];

  const wpts = [wpt(first, 'Start')];
  route.waypoints?.forEach((p, i) => wpts.push(wpt(p, `Wegpunkt ${i + 1}`)));
  wpts.push(wpt(last, 'Ziel'));

  const trkpts = coords
    .map((p) => {
      const ele = p.length > 2 && Number.isFinite(p[2]) ? `<ele>${p[2].toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${c6(p[1])}" lon="${c6(p[0])}">${ele}</trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${APP}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <desc>${esc(description)}</desc>
    <time>${now}</time>
  </metadata>
${wpts.join('\n')}
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function wpt(p, label) {
  const ele = p.length > 2 && Number.isFinite(p[2]) ? `<ele>${p[2].toFixed(1)}</ele>` : '';
  return `  <wpt lat="${c6(p[1])}" lon="${c6(p[0])}"><name>${esc(label)}</name>${ele}</wpt>`;
}

export function gpxFilename(name) {
  const slug = name
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const day = new Date().toISOString().slice(0, 10);
  return `${slug || 'motorradrunde'}-${day}.gpx`;
}

/**
 * Google-Maps-Link. Die URL-API erlaubt nur eine Handvoll Zwischenziele,
 * deshalb wird die Route auf wenige markante Punkte eingedampft. Google
 * routet zwischen diesen Punkten selbst -- der Verlauf stimmt also ungefaehr,
 * aber nicht metergenau. Fuer exaktes Nachfahren ist die GPX-Datei da.
 */
export const GOOGLE_MAX_WAYPOINTS = 8;

export function googleMapsUrl(route) {
  const coords = route.coords;
  const start = coords[0];
  const end = coords[coords.length - 1];

  const skeleton = simplify(coords, 400);
  const middle = sampleAlong(skeleton, GOOGLE_MAX_WAYPOINTS + 2).slice(1, -1);

  const params = new URLSearchParams({
    api: '1',
    origin: `${start[1].toFixed(6)},${start[0].toFixed(6)}`,
    destination: `${end[1].toFixed(6)},${end[0].toFixed(6)}`,
    travelmode: 'driving',
  });
  if (middle.length) {
    params.set('waypoints', middle.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Datei im Browser herunterladen. */
export function downloadText(filename, text, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
