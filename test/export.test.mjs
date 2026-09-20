import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGpx, googleMapsUrl, gpxFilename, GOOGLE_MAX_WAYPOINTS } from '../assets/js/export.js';
import { destination } from '../assets/js/geo.js';
import { FakeRouter } from './fake-router.mjs';

const START = [8.4117, 48.4636];

async function demoRoute() {
  const router = new FakeRouter({ wiggle: 0.5 });
  const r = await router.route([START, destination(START, 60, 15000), START]);
  return { ...r, waypoints: [destination(START, 60, 15000)] };
}

test('GPX enthaelt Track, Hoehen und Wegpunkte', async () => {
  const route = await demoRoute();
  const gpx = buildGpx(route, { name: 'Testrunde', description: '50 km' });
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1"/);
  assert.match(gpx, /<name>Testrunde<\/name>/);
  assert.match(gpx, /<wpt lat="[\d.]+" lon="[\d.]+"><name>Start<\/name>/);
  assert.match(gpx, /<name>Ziel<\/name>/);
  assert.ok((gpx.match(/<trkpt /g) ?? []).length === route.coords.length);
  assert.match(gpx, /<ele>/);
});

test('GPX maskiert Sonderzeichen im Namen', async () => {
  const gpx = buildGpx(await demoRoute(), { name: 'Tour <b>&"1"' });
  assert.ok(!gpx.includes('<b>'));
  assert.match(gpx, /Tour &lt;b&gt;&amp;&quot;1&quot;/);
});

test('Dateiname ist url- und dateisystemtauglich', () => {
  const f = gpxFilename('Große Runde über Höhen & Täler');
  assert.match(f, /^grosse-runde-ueber-hoehen-taeler-\d{4}-\d{2}-\d{2}\.gpx$/);
  assert.match(gpxFilename('///'), /^motorradrunde-/);
});

test('Google-Maps-Link bleibt unter dem Zwischenziel-Limit', async () => {
  const route = await demoRoute();
  const url = new URL(googleMapsUrl(route));
  assert.equal(url.host, 'www.google.com');
  assert.equal(url.searchParams.get('travelmode'), 'driving');
  const wp = url.searchParams.get('waypoints').split('|');
  assert.ok(wp.length <= GOOGLE_MAX_WAYPOINTS, `zu viele Wegpunkte: ${wp.length}`);
  assert.match(url.searchParams.get('origin'), /^48\.\d+,8\.\d+$/);
});
