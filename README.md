# 🏍️ Kurvenjagd

Eine Web-App, die dir die Frage abnimmt, wo du eigentlich hinfährst, wenn du Zeit
und Lust hast. Du sagst, **wie lange** du fahren willst, **wie kurvig** es sein
soll und ob es eine **Runde** oder eine **Einwegstrecke** wird – die App sucht
dir eine passende Strecke, zeigt sie auf der Karte und gibt sie als GPX raus.

Kein Build-Schritt, kein Backend, keine Anmeldung. Reines HTML, CSS und
JavaScript.

## Loslegen

```bash
node server.js          # http://localhost:8080
PORT=3000 node server.js
```

Jeder andere statische Webserver tut es genauso (`npx http-server`, `python3 -m
http.server`, nginx, GitHub Pages …). Nur direkt per `file://` öffnen geht
nicht – ES-Module brauchen ein `http://`.

Auf dem Handy: die Seite im Browser öffnen und zum Startbildschirm hinzufügen.

## Was die App kann

| | |
|---|---|
| **Start** | Per GPS, über die Ortssuche, als Koordinaten (`48.4636, 8.4117`) oder durch Antippen der Karte. Die Nadel lässt sich verschieben. |
| **Dauer** | 30 Minuten bis 8 Stunden reine Fahrzeit. |
| **Kurvigkeit** | Fünf Stufen von „gerade & zügig“ bis „Serpentinen-Modus“. |
| **Art** | Runde (endet am Start) oder Einwegstrecke – mit oder ohne festes Ziel, optional in eine Wunschrichtung. |
| **Ergebnis** | Karte, Steckbrief (Strecke, Fahrzeit, gemessene Kurvigkeit, Höhenmeter), Höhenprofil mit Fadenkreuz, mehrere Varianten zum Durchklicken. |
| **Mitnehmen** | GPX-Download (Kurviger, Calimoto, OsmAnd, Garmin …) und ein Google-Maps-Link. |
| **Sonst** | Hell/Dunkel, funktioniert am Handy, Einstellungen bleiben gespeichert. |

## Wie die Routen entstehen

Einen Router zu bitten „gib mir eine schöne kurvige Runde“ funktioniert nicht –
Router verbinden Punkte. Also erzeugt die App die Punkte selbst:

1. **Ziellänge schätzen.** Aus Wunschdauer und Wunschkurvigkeit über ein
   Geschwindigkeitsmodell: je kurviger, desto langsamer (≈ 75 km/h auf schnellen
   Landstraßen, ≈ 39 km/h im Serpentinen-Modus).
2. **Wegpunkte setzen.** Für eine Runde auf einen Ring um den Start. Je höher die
   Wunschkurvigkeit, desto mehr Wegpunkte (5 bis 9) und desto stärker wechseln
   die Radien – der Router muss dann öfter von der schnellen Hauptachse runter,
   und genau das erzeugt kurvige Strecken. Für eine Einwegstrecke liegen die
   Punkte abwechselnd links und rechts der Luftlinie.
3. **Routen lassen und nachmessen.** Aus der fertigen Geometrie werden Länge,
   Kurvigkeit (Summe der Richtungswechsel je Kilometer), Höhenmeter und der
   Anteil doppelt gefahrener Strecke berechnet.
4. **Nachjustieren.** Passt die Fahrzeit nicht, wird der Ring größer oder
   kleiner und es geht zurück zu Schritt 3 – höchstens dreimal je Variante.
5. **Beste Variante wählen.** Das Ganze läuft mehrfach mit anderen Startwinkeln.
   Gewertet wird nach Abweichung von der Wunschdauer, Treffer bei der
   Kurvigkeit, Doppeltfahren und Wendemanövern.

Der entscheidende Punkt: **Die Kurvigkeit wird nicht versprochen, sondern an der
fertigen Strecke gemessen.** Was im Steckbrief steht, ist der gemessene Wert.
Wenn die Gegend nicht mehr hergibt, sagt die App das (»kurviger gab die Gegend
nicht her«), statt eine Zahl zu behaupten.

Grobe Eichung des Kurvigkeitsmaßes in Grad Richtungswechsel je Kilometer:

| Grad/km | entspricht | Stufe |
|---:|---|---:|
| ~50 | Autobahn, schnurgerade Bundesstraße | 1 |
| ~130 | normale Landstraße | 2 |
| ~220 | Landstraße mit Schwung | 3 |
| ~330 | kleines Sträßchen, viel Kurbelei | 4 |
| ~450 | Passstraße, Serpentinen | 5 |

## Routing-Dienste

**BRouter** (Voreinstellung) – kostenlos, ohne Anmeldung, läuft auf
`brouter.de`. Die App nutzt dessen Auto-Profile (`car-eco` für kurvig,
`car-fast` für zügig). BRouter nimmt über die URL nur einen Profilnamen
entgegen: *„Autobahn meiden“* steuert hier also die Profilwahl und ist damit
eine starke Bevorzugung, keine Garantie. Ein eigener BRouter-Server lässt sich
in den Feineinstellungen eintragen.

**GraphHopper** – braucht einen kostenlosen API-Key von
[graphhopper.com](https://www.graphhopper.com/). Dafür kann die App dort
Straßenklassen direkt gewichten (`custom_model`): Autobahn, Schnellstraße,
Schotter und Fähren werden wirklich gemieden, kleine Straßen bevorzugt. Wer es
genau haben will, nimmt diesen Weg.

Beide Dienste sind über die Feineinstellungen umschaltbar.

## Was die App nicht kann

Ehrlichkeitshalber:

- **Der Google-Maps-Link ist eine Näherung.** Die URL-API erlaubt nur acht
  Zwischenziele; Google routet dazwischen selbst. Zum metergenauen Nachfahren
  ist die GPX-Datei da.
- **Die Fahrzeit ist eine Schätzung** aus Kurvigkeit und Höhenmetern – ohne
  Ampeln, Ortsdurchfahrten, Baustellen und Pausen.
- **Sie kennt keine Straßenqualität.** Ob der Belag taugt oder die Straße
  gesperrt ist, weiß nur OpenStreetMap – und das nicht immer.
- **Öffentliche Server, fair genutzt.** Zwischen den Anfragen liegt eine Pause,
  die Ortssuche hält das Limit von Nominatim ein (eine Anfrage je Sekunde). Wer
  die App dauerhaft oder für viele Leute betreibt, sollte einen eigenen
  BRouter-Server aufsetzen.
- **Höhenprofil nur, wenn der Dienst Höhen liefert.** BRouter tut das, bei
  GraphHopper ist `elevation` eingeschaltet.

## Datenschutz

Es gibt kein Backend. Einstellungen, Startpunkt und ein eventueller
GraphHopper-Key liegen ausschließlich im `localStorage` deines Browsers. Nach
außen gehen nur die Anfragen an den gewählten Routing-Dienst, an Nominatim
(Ortssuche) und an die Kartenserver.

## Tests

```bash
npm test                                            # 29 Unit-Tests, ohne Netz
NODE_PATH=$(npm root -g) node test/browser/smoke.mjs # kompletter Ablauf im Browser
```

Der Browser-Test startet den Server, fängt alle Netzaufrufe ab (Kacheln,
Ortssuche, BRouter liefern simulierte Antworten) und spielt den ganzen Ablauf
durch – Start setzen, generieren, Varianten wechseln, Höhenprofil antippen, GPX
herunterladen, Einwegstrecke, Fehlerfall. Screenshots landen in
`test/screenshots/`. Er braucht Playwright.

## Aufbau

```
index.html              Aufbau der Seite
assets/css/app.css      Gestaltung, Farb-Tokens, Hell/Dunkel
assets/js/
  app.js                Bedienung und Ablaufsteuerung
  generator.js          Wegpunkte erzeugen, nachjustieren, Varianten bewerten
  routers.js            BRouter- und GraphHopper-Adapter, Ortssuche
  geo.js                Geodäsie, Kurvigkeit, Höhenstatistik, Überlappung
  elevation.js          Höhenprofil als Inline-SVG
  mapview.js            Leaflet-Hülle
  export.js             GPX und Google-Maps-Link
  store.js              Einstellungen im Browser
server.js               kleiner Entwicklungsserver
vendor/leaflet/         Leaflet 1.9.4, mitgeliefert statt per CDN
```

## Karten und Daten

Karten und Routing beruhen auf [OpenStreetMap](https://www.openstreetmap.org/copyright)
(ODbL). Kacheln von OpenStreetMap und [OpenTopoMap](https://opentopomap.org)
(CC-BY-SA), Routing von [BRouter](https://brouter.de) bzw. GraphHopper,
Ortssuche von [Nominatim](https://nominatim.openstreetmap.org).
[Leaflet](https://leafletjs.com) steht unter BSD-2-Clause (siehe
`vendor/leaflet/LICENSE`).

Gute Fahrt. 🏍️
