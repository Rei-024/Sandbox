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
2. **Wegpunkte setzen.** Für eine Runde auf einen Ring, dessen Mittelpunkt eine
   Radiuslänge in Fahrtrichtung liegt – der Start sitzt also auf dem *Rand* der
   Schleife, nicht in ihrer Mitte. Je höher die Wunschkurvigkeit, desto mehr
   Wegpunkte (5 bis 9) und desto stärker wechseln die Radien – der Router muss
   dann öfter von der schnellen Hauptachse runter, und genau das erzeugt kurvige
   Strecken. Für eine Einwegstrecke liegen die Punkte abwechselnd links und
   rechts der Luftlinie.
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

### Warum die Schleife neben dem Start liegt

Naheliegend wäre ein Ring **um** den Start. Der hat zwei Fehler, und beide
fallen erst beim Fahren auf.

Erstens ist eine Wunschrichtung an einem Vollkreis wirkungslos: sie dreht ihn
nur, und ein gedrehter Vollkreis ist derselbe Vollkreis. Wer Südwesten wählte,
bekam eine Runde, die auch nach Südwesten führte – und genauso nach Nordosten.

Zweitens zwingt ein Ring um den Start zur **Acht**, sobald der Startort ein
Talknoten ist. Liegen die Wegpunkte rundherum, muss die Route irgendwann von
der einen Seite auf die andere – und der einzige Weg dorthin führt durch den
Startort zurück. Heraus kommen zwei Runden mit gemeinsamem Knoten statt einer.

Liegt die Schleife dagegen neben dem Start, hat sie beide Probleme nicht: die
Richtung ist die Lage der Schleife, und eine Runde auf einer Seite braucht den
Startort nicht als Durchgang.

Der Preis ist Reichweite: die Schleife reicht doppelt so weit weg wie ihr
Radius. Gibt die Gegend das nicht her – Talende, See, Grenze –, wird sie
schrittweise zum Start zurückgezogen. Das lässt sich schon **vor** dem ersten
Routing erkennen: wenn das Aufschnappen auf Straßen die Wegpunkte im Schnitt um
mehr als 30 % des Radius verschiebt, liegt der Ring zum guten Teil neben jeder
Straße. Diese Auskunft kostet keine Anfrage.

Mit gewählter Richtung wird nur bis zur Hälfte zurückgezogen. Ein Ring rings um
den Start wäre die Absage an jede Richtung, und eine kürzere Runde nach
Südwesten ist mehr wert als eine zeitgenaue, die überallhin führt. Geht es gar
nicht, sagt die App es (»Nach Südwesten gab die Gegend keine passende Runde
her«).

Wird am Ende doch eine Acht daraus, steht sie im Steckbrief: »unterwegs einmal
wieder am Start vorbei«. Im Gebirge ist sie manchmal das Beste, was es gibt.

### Autobahn vermeiden – und warum das Häkchen lange nichts tat

BRouter nimmt über die URL nur einen Profilnamen entgegen. Die Straßenwahl
lässt sich damit nicht pro Anfrage steuern, und `car-eco` fährt Autobahn. Das
Häkchen »Autobahn vermeiden« hatte deshalb bei BRouter **keinerlei Wirkung** –
aufgefallen ist das erst, als eine Route sichtbar über die A10 führte.

Sperrzonen nimmt BRouter dagegen entgegen. Es fehlten nur die Daten: Autobahnen
standen gar nicht in der Overpass-Abfrage. Jetzt schon – aber getrennt von den
fahrbaren Straßen: auf eine Autobahn wird nie ein Wegpunkt gezogen, sie ist nur
dafür da, dass die App weiß, wo sie liegt.

Eine Vorsicht dabei: im Tal hat eine Autobahn oft die Bundesstraße als direkte
Nachbarin. Liegt eine erlaubte Straße innerhalb des Sperrkreises, wird dort
**nicht** gesperrt – sonst ist das Tal dicht statt die Autobahn gemieden. Der
Sperrkreis ist mit 80 m auch enger als bei der Maut (150 m).

Dass von jedem Weg nur ein Mittelpunkt bekannt ist, stört hier wenig:
OpenStreetMap zerlegt eine Autobahn in viele kurze Wege, die Mittelpunkte
liegen also dicht genug, um sie als Durchfahrt unbrauchbar zu machen.

Bleibt am Ende doch ein Stück Autobahn übrig, sagt die App es.

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

### Ast, Schleife oder Serpentine?

Beim Schneiden kommt es darauf an, drei Dinge auseinanderzuhalten:

- **Sackgasse** – rein und auf demselben Weg heraus. Soll weg.
- **Kleine Schleife** – rein und auf anderem Weg heraus. Kein Doppeltfahren,
  soll bleiben. Erkennbar daran, dass sich Hin- und Rückweg nicht decken
  (`retraceRatio`: Ast 1,0, Schleife 0,0).
- **Serpentine** – zwei Kehrenschenkel liegen waagerecht nur 30 bis 40 Meter
  auseinander und sehen damit aus wie hin und zurück. Sie liegen aber
  **übereinander**: ein Höhenunterschied an der Schließstelle verrät die
  Bergstraße. Ohne diese Prüfung schnitt die App ausgerechnet das weg, wofür
  man überhaupt losfährt.

Zwei Grenzen schützen davor, zu viel wegzunehmen: ein einzelner Schnitt darf
höchstens 60 % der Route treffen, alle zusammen höchstens 50 % – beides gegen
die *ursprüngliche* Länge gerechnet.

Simulation mit vier Sackgassentälern rund um den Start, 15 Durchläufe:
Doppeltfahren im Median 0 %, im Maximum 2 % (vorher bis 83 %).

### Drei Vorschläge, nicht dreimal derselbe

Die Varianten starten in gleichmäßig über den Kreis verteilte Richtungen –
auch wenn die Richtung egal ist. Würfelte jede für sich, kamen regelmäßig drei
fast gleiche Runden heraus. Danach wird die Auswahl nach Verschiedenheit
sortiert: die beste zuerst, dann jeweils die nächste, die sich deutlich
unterscheidet. Gibt die Gegend nichts Verschiedenes her, sagt die App das,
statt drei Zwillinge als Auswahl auszugeben.

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

## Oberfläche

Die Karte ist die Seite, nicht ein Kasten darauf. Alles andere schwebt darüber:
oben der Name und der Hell/Dunkel-Schalter, rechts Standort und Nadel, über der
Karte eine Blase für den Fortschritt.

Am Handy sitzt das Bedienblatt unten und hat drei Rasten – zugeklappt bleiben
die Zusammenfassung (Dauer, Kurvigkeit, Art) und der Startknopf stehen, halb
offen liest man den Steckbrief und sieht die Route, ganz offen steht das volle
Formular da. Ziehen am Griff rastet ein, Antippen schaltet weiter. Eine Raste
ist eine **Höhe**, keine Verschiebung: so rutscht der große Knopf nie unten aus
dem Bild. Nach dem Generieren geht das Blatt von selbst halb auf, und die Route
wird in genau den Platz eingepasst, der daneben übrig bleibt.

Ab 900 px Breite wird aus dem Blatt eine feste Seitenspalte, die Karte bleibt
vollflächig daneben.

Farben: Grau als Grundton, Orange für alles zum Anfassen, Rot für die Route und
das Höhenprofil. Die Kartenfarben kippen bewusst **nicht** mit dem Dunkelmodus –
eine rote Linie muss auf hellen wie dunklen Kacheln dieselbe Linie sein.

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
  Mittelpunkt bekannt, nicht ihr Verlauf – deshalb heißt es „möglicherweise",
  statt Sicherheit vorzutäuschen. Gewarnt wird nur, wenn die *fertige* Route
  an einer bekannten Mautstraße entlangführt: dass unterwegs eine Sperrzone
  fallen musste, liegt meist an einem unerreichbaren Wegpunkt und hat mit Maut
  nichts zu tun.
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
npm test                                            # 109 Unit-Tests, ohne Netz
node --test test/stress.mjs                         # 300 Zufallsläufe gegen Zufallswelten
NODE_PATH=$(npm root -g) node test/browser/smoke.mjs # kompletter Ablauf im Browser
```

Der Browser-Test startet den Server, fängt alle Netzaufrufe ab (Kacheln,
Ortssuche, BRouter liefern simulierte Antworten) und spielt den ganzen Ablauf
durch – Start setzen, generieren, Varianten wechseln, Höhenprofil antippen, GPX
herunterladen, Einwegstrecke, Overpass-Ausfall, Fehlerfall. Dazu misst er die
Oberfläche nach: dass die Hülle im Bildschirm festsitzt, dass am Handy der
Startknopf auch im zugeklappten Blatt sichtbar bleibt und dass nichts waagerecht
überläuft. Screenshots landen in `test/screenshots/`. Er braucht Playwright.

Die Belastungsprobe (`test/stress.mjs`) baut zufällige Straßennetze und lässt
die App zufällige Wünsche darauf lösen. Geprüft wird nicht der Geschmack,
sondern das, was nie passieren darf: eine Runde, die nicht am Start endet,
Sprünge in der Geometrie, eine Längenangabe, die nicht zur Linie passt,
kaputtes GPX.

Zwei Welten, weil eine nicht reicht:

- **Offenes Land** – konzentrische Ringe, Speichen, Sackgassen, Inseln,
  Mautstraßen, Höhenrelief. Hier ist alles mit allem verbunden.
- **Alpenwelt** (`talwelt`) – ein Talort als Knoten, davon abgehende Täler,
  manche enden als Lutscher (langer Stiel, kleine Wendeschleife), und nur
  manchmal verbindet ein Pass zwei Talköpfe. Hier führt der Weg von einem Tal
  ins nächste oft durch den Startort zurück.

In der Alpenwelt fährt der Testrouter auf einem **echten Graphen**
(`test/graph.mjs`: Rasterknoten, Dijkstra) statt eine geschlängelte Linie von
Wegpunkt zu Wegpunkt zu ziehen. Das ist der Unterschied zwischen einem
Prüfstand, der Sackgassen und Achten melden *kann*, und einem, der für beides
immer null meldet – während es auf dem Bildschirm steht. Genau das war er
vorher.

Gemessen wird deshalb auch, was den Fahrer stört und keinen Lauf abstürzen
lässt: Anteil doppelt gefahrener Strecke, Anteil Achten statt Runden, und um
wie viel Grad die gefahrene Richtung die gewünschte verfehlt. Für alle vier
Kennzahlen stehen Obergrenzen im Prüfstand – sie sind eine Sperre gegen
Rückfall, kein Ziel.

#### Eine Kennzahl, die springt, misst die Würfel

Zwei Fallen haben hier erst einmal falsche Schlüsse produziert, beide wert,
aufgeschrieben zu werden:

**Geteilte Zufallsströme.** Anfrage und Weltenbau zogen aus demselben Strom.
Eine zusätzliche Zeile im Weltenbau verschiebt dann alle späteren Zufallszahlen
– zwei Messungen vergleichen unterschiedliche Welten statt unterschiedlicher
Verfahren. Ein Zusatz, der eine Kennzahl scheinbar von 18 auf 73 Prozent trieb,
hatte in Wahrheit nur die Karten neu gemischt. Welt und Anfrage haben jetzt
getrennte Ströme.

**Tail-Werte auf kleiner Stichprobe.** Das P90 des Doppeltfahrens schwankt über
rund achtzig Gebirgsrunden allein durch die Saat zwischen 9 und 26 Prozent.
Anteile und Mediane bleiben stabil. Die Schranken hängen deshalb an Anteilen,
nicht an P90 – nachprüfbar mit `SAAT=1 node test/stress.mjs`.

Und die Alpenwelt garantiert mindestens einen Pass zwischen zwei Talköpfen.
Ohne ihn gibt es dort überhaupt keine Runde, und der Prüfstand misst dann, ob
die Würfel eine lösbare Gegend ausgespuckt haben – nicht, ob die App sie löst.

Sieben echte Fehler sind so gefunden worden, die von Hand niemand gesehen
hätte – und eine falsche Zusicherung: »nie mehr als 50 % doppelt« behauptete
eine Schranke, die das Maß gar nicht hat (`overlapDetail` zählt jeden
Wiederbesuch, ein dreifach befahrener Abschnitt kommt also legitim darüber).
Sie ist jetzt eine gezählte Qualitätszahl statt einer Zusicherung.

## Aufbau

```
index.html              Aufbau der Seite
assets/css/app.css      Gestaltung, Farb-Tokens, Hell/Dunkel
assets/js/
  app.js                Bedienung und Ablaufsteuerung
  sheet.js              Bedienblatt am Handy: drei Rasten, ziehen und tippen
  generator.js          Wegpunkte erzeugen, nachjustieren, Varianten bewerten
  routers.js            BRouter- und GraphHopper-Adapter, Ortssuche
  roads.js              Straßennetz über Overpass, Wegpunkte aufschnappen
  geo.js                Geodäsie, Kurvigkeit, Höhenstatistik, Überlappung
  elevation.js          Höhenprofil als Inline-SVG
  mapview.js            Leaflet-Hülle
  export.js             GPX und Google-Maps-Link
  store.js              Einstellungen im Browser
server.js               kleiner Entwicklungsserver
test/stress.mjs         Belastungsprobe gegen zufällige Straßennetze
test/fake-router.mjs    simulierter Routing-Dienst für die Tests
test/graph.mjs          Straßengraph mit Dijkstra für die Alpenwelt
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
