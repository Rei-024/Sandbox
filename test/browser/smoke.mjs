/**
 * Browser-Rauchtest.
 *
 * Startet den Dev-Server, faengt alle Netzaufrufe ab (Kacheln, Ortssuche,
 * BRouter) und spielt einmal den kompletten Ablauf durch: Start setzen,
 * Strecke generieren, Ergebnis pruefen, GPX herunterladen.
 *
 * Braucht Playwright:  NODE_PATH=$(npm root -g) node test/browser/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destination, distance } from '../../assets/js/geo.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = join(ROOT, 'test/screenshots');

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures++;
};

/** Baut aus den angefragten Wegpunkten eine geschlaengelte Fake-Route. */
function fakeGeoJson(lonlats) {
  const points = lonlats.split('|').map((p) => p.split(',').map(Number));
  const coords = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = distance(a, b);
    const steps = Math.max(4, Math.round(len / 120));
    const head = heading(a, b);
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const base = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const off = Math.min(300, len * 0.06) * Math.sin(2 * Math.PI * Math.max(1, len / 1500) * t);
      const p = destination(base, head + 90, off);
      coords.push([
        Number(p[0].toFixed(6)),
        Number(p[1].toFixed(6)),
        Math.round(420 + 260 * Math.sin(5 * Math.PI * t) + 90 * Math.sin(13 * Math.PI * t)),
      ]);
    }
  }
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += distance(coords[i - 1], coords[i]);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          'track-length': String(Math.round(len)),
          'total-time': String(Math.round(len / 16)),
          'filtered ascend': String(Math.round(len / 1000) * 14),
        },
        geometry: { type: 'LineString', coordinates: coords },
      },
    ],
  };
}

function heading(a, b) {
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const l1 = (a[1] * Math.PI) / 180;
  const l2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(l2);
  const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* noch nicht da */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server ist nicht hochgekommen');
}

const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  await waitForServer(BASE);
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    acceptDownloads: true,
    locale: 'de-DE',
  });

  let routingCalls = 0;
  let overpassCalls = 0;

  // Strassennetz: ein Ring aus Nebenstrassen um Freudenstadt.
  await context.route('**/api/interpreter', (r) => {
    overpassCalls++;
    const elements = [];
    for (let ring = 6000; ring <= 22000; ring += 4000) {
      for (let grad = 0; grad < 360; grad += 9) {
        const p = destination([8.4117, 48.4636], grad, ring);
        elements.push({
          type: 'way',
          id: elements.length,
          center: { lat: p[1], lon: p[0] },
          tags: { highway: grad % 27 === 0 ? 'secondary' : 'tertiary' },
        });
      }
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ elements }),
    });
  });
  await context.route('**://*.tile.openstreetmap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
  );
  await context.route('**://tile.**/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
  );
  await context.route('**://nominatim.openstreetmap.org/**', (r) => {
    const url = new URL(r.request().url());
    const body = url.pathname.includes('reverse')
      ? { address: { town: 'Freudenstadt' }, name: 'Freudenstadt' }
      : [{ display_name: 'Freudenstadt, Baden-Württemberg, Deutschland', lon: '8.4117', lat: '48.4636' }];
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.route('**://brouter.de/**', (r) => {
    routingCalls++;
    const lonlats = new URL(r.request().url()).searchParams.get('lonlats');
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fakeGeoJson(lonlats)),
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // "Failed to load resource" ist eine Netzmeldung des Browsers, kein
    // JS-Fehler -- der Ausfalltest weiter unten loest sie absichtlich aus.
    const belanglos = /favicon|tile|Failed to load resource/i;
    if (m.type() === 'error' && !belanglos.test(m.text())) errors.push(m.text());
  });

  await page.addInitScript(() => {
    // Kein echtes GPS im Test -- die App soll dann still auf Handeingabe warten.
    navigator.geolocation.getCurrentPosition = (_ok, fail) =>
      fail({ code: 1, PERMISSION_DENIED: 1 });
  });

  console.log('\n# Seite laedt');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check((await page.title()) === 'Kurvenjagd', 'Titel stimmt');
  check(await page.locator('.leaflet-container').isVisible(), 'Karte ist da');
  check(await page.locator('#placeholder').isVisible(), 'Platzhalter vor der ersten Suche');
  check(await page.locator('#result').isHidden(), 'Ergebnisblock bleibt vorher verborgen');
  check((await page.locator('#curviness .segmented__item').count()) === 5, 'Fuenf Kurvigkeitsstufen');

  console.log('\n# Eingaben');
  await page.fill('#start-input', '48.4636, 8.4117');
  await page.press('#start-input', 'Enter');
  await page.locator('#duration').fill('150');
  check((await page.locator('#duration-out').textContent()).includes('2 h 30'), 'Dauer wird lesbar angezeigt');
  await page.locator('#curviness-4').check({ force: true });
  check(
    (await page.locator('#curviness-hint').textContent()).includes('Richtig kurvig'),
    'Kurvigkeitstext passt zur Auswahl',
  );

  console.log('\n# Generieren');
  await page.click('#generate-btn');
  await page.locator('#result').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('generate-btn').disabled, null, {
    timeout: 30000,
  });

  check(overpassCalls === 1, `Strassennetz genau einmal geladen (${overpassCalls}x)`);
  check(routingCalls > 0 && routingCalls <= 16, `Routing-Anfragen: ${routingCalls}`);
  check((await page.locator('#stats .stat').count()) === 4, 'Vier Kennzahlen im Steckbrief');
  check(
    (await page.locator('#route-variants .chip').count()) === 3,
    'Genau drei Varianten zur Auswahl (eine je Durchlauf)',
  );
  check((await page.locator('.elevation__line').count()) === 1, 'Hoehenprofil gezeichnet');
  check((await page.locator('#elevation-table tbody tr').count()) === 11, 'Tabellenansicht gefuellt');
  check(await page.locator('#alert').isHidden(), 'Keine Fehlermeldung');

  await page
    .waitForFunction(() => /^Runde ab /.test(document.getElementById('route-name').textContent), null, { timeout: 15000 })
    .catch(() => {});
  const name = await page.locator('#route-name').textContent();
  check(/Runde ab Freudenstadt/.test(name), `Routenname: "${name}"`);

  const stats = await page.locator('#stats').innerText();
  const km = Number(stats.match(/([\d.,]+)\s*km/)?.[1]?.replace(',', '.'));
  check(km > 60 && km < 240, `Strecke plausibel fuer 2,5 h: ${km} km`);
  const dauer = await page.locator('.stat:nth-child(2) .stat__value').innerText();
  const min = Number(dauer.match(/(\d+) h/)?.[1] ?? 0) * 60 + Number(dauer.match(/(\d+) min/)?.[1] ?? 0);
  check(Math.abs(min - 150) / 150 < 0.2, `Fahrzeit nahe am Wunsch: ${dauer}`);

  const gmaps = await page.locator('#gmaps-btn').getAttribute('href');
  check(gmaps.startsWith('https://www.google.com/maps/dir/?'), 'Google-Maps-Link gebaut');

  console.log('\n# Interaktion');
  const profil = page.locator('.elevation__svg');
  await profil.scrollIntoViewIfNeeded();
  const svg = await profil.boundingBox();
  await profil.hover({ position: { x: svg.width * 0.55, y: svg.height / 2 } });
  check(await page.locator('.elevation__tooltip').isVisible(), 'Tooltip im Hoehenprofil');
  check(await page.locator('.route-hover').count() === 1, 'Punkt auf der Karte folgt dem Profil');

  await page.locator('#route-variants .chip').nth(1).click();
  check(
    (await page.locator('#route-variants .chip').nth(1).getAttribute('aria-pressed')) === 'true',
    'Variante laesst sich wechseln',
  );

  console.log('\n# GPX');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#gpx-btn')]);
  const gpxPath = join(SHOTS, 'route.gpx');
  await download.saveAs(gpxPath);
  const gpx = await readFile(gpxPath, 'utf8');
  check(download.suggestedFilename().endsWith('.gpx'), `Dateiname: ${download.suggestedFilename()}`);
  check(gpx.includes('<trkpt') && gpx.includes('<ele>'), 'GPX enthaelt Trackpunkte mit Hoehe');

  console.log('\n# Einwegstrecke');
  await page.locator('#mode-oneway').check({ force: true });
  check(await page.locator('#oneway-extra').isVisible(), 'Zielfeld erscheint');
  await page.selectOption('#bearing', '90');
  await page.locator('#duration').fill('90');
  routingCalls = 0;
  await page.click('#generate-btn');
  await page.waitForFunction(() => !document.getElementById('generate-btn').disabled, null, {
    timeout: 30000,
  });
  check(routingCalls > 0, `Einwegstrecke wurde geroutet (${routingCalls} Anfragen)`);
  await page
    .waitForFunction(() => /^Von /.test(document.getElementById('route-name').textContent), null, { timeout: 15000 })
    .catch(() => {});
  const owName = await page.locator('#route-name').textContent();
  check(/^Von .+ nach .+/.test(owName), `Name nennt Start und Ziel: "${owName}"`);
  const endsAway = await page.evaluate(() => {
    const href = document.getElementById('gmaps-btn').href;
    const u = new URL(href);
    return u.searchParams.get('origin') !== u.searchParams.get('destination');
  });
  check(endsAway, 'Einwegstrecke endet nicht am Start');

  console.log('\n# Strassennetz nicht erreichbar');
  await context.route('**/api/interpreter', (r) => r.fulfill({ status: 504, body: 'gateway timeout' }));
  await page.locator('#mode-loop').check({ force: true });
  await page.locator('#duration').fill('300'); // anderer Suchradius -> nicht aus dem Speicher
  await page.click('#generate-btn');
  await page.waitForFunction(() => !document.getElementById('generate-btn').disabled, null, {
    timeout: 40000,
  });
  const netzWarnung = await page.locator('#alert').textContent();
  check(/Straßennetz/.test(netzWarnung), `Ausfall wird erklaert: "${netzWarnung.slice(0, 70)}…"`);
  check(await page.locator('#result').isVisible(), 'trotzdem kommt eine Route heraus');

  console.log('\n# Fehlerfall');
  await page.locator('#advanced').evaluate((el) => el.setAttribute('open', ''));
  await page.selectOption('#provider', 'graphhopper');
  await page.click('#generate-btn');
  await page.locator('#alert').waitFor({ state: 'visible', timeout: 15000 });
  const alertText = await page.locator('#alert').textContent();
  check(/API-Key/.test(alertText), `Fehlender Key wird erklärt: "${alertText.slice(0, 60)}…"`);
  await page.selectOption('#provider', 'brouter');

  console.log('\n# Darstellung');
  await page.locator('#mode-loop').check({ force: true });
  await page.screenshot({ path: join(SHOTS, 'desktop-hell.png'), fullPage: true });
  await page.click('#theme-toggle');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, 'desktop-dunkel.png'), fullPage: true });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(BASE, { waitUntil: 'networkidle' });
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, `Kein waagerechtes Scrollen am Handy (Ueberhang ${overflow}px)`);
  await mobile.screenshot({ path: join(SHOTS, 'mobil.png'), fullPage: true });

  check(errors.length === 0, `Keine JS-Fehler${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  await browser.close();
} finally {
  server.kill();
}

console.log(`\n${failures ? `${failures} Pruefung(en) fehlgeschlagen` : 'Alle Pruefungen bestanden'}`);
process.exit(failures ? 1 : 0);
