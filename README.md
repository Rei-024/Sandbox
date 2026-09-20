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
| **Meiden** | Autobahn, Schotter und Mautstraßen – jeweils abschaltbar. |
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

### Warum das Straßennetz nötig ist

Wegpunkte geometrisch auf einen Kreis zu würfeln funktioniert nur, wo überall
Straßen sind. Im Gebirge landen sie auf Waldwegen, in Sackgassentälern oder
ganz ohne Straße in der Nähe – der Router bricht dann mit „target island
detected" ab oder fährt Seitentäler rein und auf demselben Weg wieder raus.

Simulation eines Talsystems (Rundkurs aus Straßen, ringsum Berg), 20 Durchläufe
à drei Varianten:

| | blind | mit Straßenwissen |
|---|---:|---:|
| Suche erfolgreich | 0 / 20 | **20 / 20** |
| Varianten im Schnitt | 0,0 | **3,0** |
| Doppeltfahren (Median) | – | **0 %** |
| abgelehnte Wegpunkte | 240 | **14** |

Fällt Overpass aus, arbeitet die App blind weiter und sagt es in der
Oberfläche. Abschalten lässt es sich in den Feineinstellungen.

## Routing-Dienste

**BRouter** (Voreinstellung) – kostenlos, ohne Anmeldung, läuft auf
`brouter.de`. Die App nutzt dessen Auto-Profile (`car-eco` für kurvig,
`car-fast` für zügig). BRouter nimmt über die URL nur einen Profilnamen
entgegen: *„Autobahn meiden“* steuert hier also die Profilwahl und ist damit
eine starke Bevorzugung, keine Garantie. Ein eigener BRouter-Server lässt sich
in den Feineinstellungen eintragen.

**GraphHopper** – braucht einen API-Key von
[graphhopper.com](https://www.graphhopper.com/). Dafür kann die App dort
Straßenklassen direkt gewichten (`custom_model`): Autobahn, Schnellstraße,
Schotter, Fähren **und Mautstraßen** werden wirklich gemieden, kleine Straßen
bevorzugt. Und GraphHopper bringt mit `algorithm=round_trip` eine eigene
Rundkurs-Suche mit – die arbeitet direkt auf dem Straßengraphen, statt Wegpunkte
zu würfeln, und umgeht damit Sackgassen und Stichstraßen von vornherein. Im
Gebirge ist das der spürbar bessere Weg.

### Ast oder Schleife?

Beim Schneiden kommt es darauf an, eine Sackgasse von einer kleinen Schleife
zu unterscheiden – rein und auf anderem Weg heraus ist kein Doppeltfahren und
soll bleiben. Dafür wird die erste Hälfte des Teilwegs gegen die zweite
gehalten (`retraceRatio`): bei einem Ast deckt sich alles (1,0), bei einer
Schleife nichts (0,0). Zwei weitere Grenzen schützen davor, zu viel
wegzunehmen: ein einzelner Schnitt darf höchstens 60 % der Route treffen, alle
zusammen höchstens 50 % – beides gegen die *ursprüngliche* Länge gerechnet.

Simulation mit vier Sackgassentälern rund um den Start, 15 Durchläufe:
Doppeltfahren im Median 0 %, im Maximum 2 % (vorher bis 83 %).

### Maut umfahren ohne zweiten Dienst

Zwei Routing-Dienste hintereinanderzuschalten (einer findet den Korridor, der
andere verfeinert ihn) klingt verlockend, bringt aber wenig: Je enger man den
zweiten führt, desto weniger kann er beitragen – und je lockerer, desto eher
landet er wieder auf der Mautstraße. Dazu doppelte Anfragen und doppelte
Latenz.

Die Arbeitsteilung liegt woanders: **Overpass weiß, wo die Mautstraßen sind,
BRouter weiß, wie man einen Ort umfährt.** Also werden die bekannten
Mautstraßen als Sperrzonen (`nogos`) an BRouter übergeben – das kostet keine
einzige zusätzliche Anfrage und keinen Key. Gibt es ohne Maut keinen Weg,
fällt die Sperre und die App sagt es, statt gar keine Route zu liefern.

**OpenRouteService** – kostenloser Key von
[openrouteservice.org](https://openrouteservice.org/). Autobahn, Maut und
Fähren werden über `avoid_features` exakt gemieden, und zwar **schon im
kostenlosen Tarif**. Belagsfilter (Schotter) kennt es fürs Auto nicht.

Was welcher Dienst kann:

| | BRouter | OpenRouteService | GraphHopper gratis |
|---|---|---|---|
| API-Key nötig | nein | ja (kostenlos) | ja |
| Autobahn meiden | über die Profilwahl | **exakt** | nein |
| Mautstraßen meiden | **Sperrzonen** | **exakt** | nein |
| Schotter meiden | über die Profilwahl | nein | nein |
| Rundkurs-Suche | eigene Wegpunkte | Versuch, sonst Wegpunkte | nein |
| Punkte je Anfrage | 30 | 25 | 5 |

> **GraphHopper im Gratis-Tarif lohnt für diese App nicht.** Autobahn-/Maut-Meiden
> und die Rundkurs-Suche brauchen dort den flexiblen Modus (`ch.disable`), und
> den lehnt der kostenlose Tarif ab („Free packages cannot use flexible mode").
> Übrig bleibt schnellstes Autorouting ohne Eco-Profil – weniger, als BRouter
> ohne jeden Key liefert. Die App erkennt das, fragt danach schlicht weiter und
> sagt es in der Oberfläche.

Alle Dienste sind über die Feineinstellungen umschaltbar. Streikt eine
Rundkurs-Suche, fällt die App auf die eigenen Wegpunkte zurück und sagt es.
Verrät ein Dienst seine Punktgrenze erst in der Fehlermeldung, lernt die App
sie daraus.

## Was die App nicht kann

Ehrlichkeitshalber:

- **Der Google-Maps-Link ist eine Näherung.** Die URL-API erlaubt nur acht
  Zwischenziele; Google routet dazwischen selbst. Zum metergenauen Nachfahren
  ist die GPX-Datei da.
- **Die Fahrzeit ist eine Schätzung** aus Kurvigkeit und Höhenmetern – ohne
  Ampeln, Ortsdurchfahrten, Baustellen und Pausen.
- **Sie kennt keine Straßenqualität.** Ob der Belag taugt oder die Straße
  gesperrt ist, weiß nur OpenStreetMap – und das nicht immer.
- **Der Maut-Hinweis ist ein Hinweis.** Von jeder Straße ist nur ein
  Mittelpunkt bekannt, nicht ihr Verlauf. Mit BRouter kann die App Maut nur von
  den Wegpunkten fernhalten, nicht von der Strecke dazwischen – deshalb warnt
  sie mit „möglicherweise", statt Sicherheit vorzutäuschen.
- **Öffentliche Server, fair genutzt.** Zwischen den Anfragen liegt eine Pause,
  die Ortssuche hält das Limit von Nominatim ein (eine Anfrage je Sekunde), das
  Straßennetz wird einmal je Suche geholt und zwischengespeichert. Wer die App
  dauerhaft oder für viele Leute betreibt, sollte einen eigenen BRouter-Server
  aufsetzen.
- **Manchmal gibt es keine Runde.** In einem engen Alpental existiert in zwei
  Stunden schlicht kein Rundkurs. Dann bleibt ein Rest Doppeltfahren übrig – die
  App versteckt das nicht, sondern schreibt den Prozentwert in den Steckbrief.
- **Höhenprofil nur, wenn der Dienst Höhen liefert.** BRouter tut das, bei
  GraphHopper ist `elevation` eingeschaltet.

## Datenschutz

Es gibt kein Backend. Einstellungen, Startpunkt und ein eventueller
GraphHopper-Key liegen ausschließlich im `localStorage` deines Browsers. Nach
außen gehen nur die Anfragen an den gewählten Routing-Dienst, an Nominatim
(Ortssuche) und an die Kartenserver.

## Tests

```bash
npm test                                            # 92 Unit-Tests, ohne Netz
NODE_PATH=$(npm root -g) node test/browser/smoke.mjs # kompletter Ablauf im Browser
```

Der Browser-Test startet den Server, fängt alle Netzaufrufe ab (Kacheln,
Ortssuche, BRouter liefern simulierte Antworten) und spielt den ganzen Ablauf
durch – Start setzen, generieren, Varianten wechseln, Höhenprofil antippen, GPX
herunterladen, Einwegstrecke, Overpass-Ausfall, Fehlerfall. Screenshots landen in
`test/screenshots/`. Er braucht Playwright.

## Aufbau

```
index.html              Aufbau der Seite
assets/css/app.css      Gestaltung, Farb-Tokens, Hell/Dunkel
assets/js/
  app.js                Bedienung und Ablaufsteuerung
  generator.js          Wegpunkte erzeugen, nachjustieren, Varianten bewerten
  routers.js            BRouter- und GraphHopper-Adapter, Ortssuche
  roads.js              Straßennetz über Overpass, Wegpunkte aufschnappen
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
Ortssuche von [Nominatim](https://nominatim.openstreetmap.org), Straßennetz
über [Overpass](https://overpass-api.de).
[Leaflet](https://leafletjs.com) steht unter BSD-2-Clause (siehe
`vendor/leaflet/LICENSE`).

Gute Fahrt. 🏍️
