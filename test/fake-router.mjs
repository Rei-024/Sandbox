/**
 * Simulierter Router fuer die Tests.
 *
 * Verbindet die uebergebenen Punkte mit einer sinusfoermig geschlaengelten
 * Linie. Damit entsteht eine Geometrie mit realistischer Laenge, Kurvigkeit
 * und Hoehe -- genug, um Generator und Kennzahlen ohne Netzzugriff zu pruefen.
 */
import { destination, distance, lineLength } from '../assets/js/geo.js';
import { RoutingError, classifyBRouterMessage } from '../assets/js/routers.js';

export class FakeRouter {
  /**
   * @param {number} wiggle 0 = schnurgerade, 1 = sehr kurvig
   * @param {Array<{center: [number, number], radiusM: number}>} islands
   *        Zonen, die der Router nicht erreichen kann -- so verhaelt sich
   *        BRouter bei Waldwegen und abgeschnittenen Netzstuecken.
   * @param {Array<{center: [number, number], radiusM: number}>} deadEnds
   *        Sackgassentaeler: erreichbar, aber nur auf demselben Weg wieder
   *        heraus. Genau daraus entstehen die Stichstrassen.
   * @param {import('./graph.mjs').RoadGraph} graph
   *        Echtes Strassennetz. Ist es gesetzt, wird darauf mit Dijkstra
   *        gefahren statt Luftlinie geschlaengelt.
   * @param {Array<[number, number]>} corridors
   *        Dicht abgetastete Punkte entlang der vorhandenen Strassen. Sind
   *        sie gesetzt, ist alles weiter als corridorWidthM davon entfernt
   *        unerreichbar -- so verhaelt sich ein Alpental wirklich.
   */
  constructor({
    wiggle = 0.5,
    // 40 m Punktabstand wie echte Routerausgabe. Mit grober Abtastung und
    // kraeftiger Welle lagen aufeinanderfolgende Punkte hunderte Meter
    // auseinander -- die Geometrie war dann unrealistischer als jede
    // Strasse und verfaelschte die Zusicherungen.
    stepM = 40,
    islands = [],
    deadEnds = [],
    corridors = [],
    corridorWidthM = 700,
    graph = null,
    supportsRoundTrip = false,
    roundTripFails = false,
    maxPoints = 30,
    echterGrenzwert = null,
  } = {}) {
    this.wiggle = wiggle;
    this.stepM = stepM;
    this.islands = islands;
    this.deadEnds = deadEnds;
    this.corridors = corridors;
    this.corridorWidthM = corridorWidthM;
    // Mit Graph faehrt der Router wirklich auf Strassen: was nicht verbunden
    // ist, ist nicht erreichbar, und aus einer Sackgasse kommt man nur auf
    // demselben Weg heraus. Ohne Graph bleibt es bei der geschlaengelten
    // Linie -- die reicht fuer alles, was nicht von der Vernetzung abhaengt.
    this.graph = graph;
    this.supportsRoundTrip = supportsRoundTrip;
    this.roundTripFails = roundTripFails;
    this.roundTrips = 0;
    this.maxPoints = maxPoints;
    // Verschweigt der Dienst seine Grenze und meckert erst beim Anecken?
    this.echterGrenzwert = echterGrenzwert;
    this.zuVielePunkte = 0;
    this.calls = 0;
    this.rejections = 0;
    this.sperrenGefallen = 0;
    this.provider = 'fake';
  }

  get capabilities() {
    return { roundTrip: this.supportsRoundTrip, maxPoints: this.maxPoints };
  }

  /** Kreis durch den Start mit ungefaehr der gewuenschten Laenge. */
  async roundTrip(start, distanceM) {
    this.calls++;
    this.roundTrips++;
    if (this.roundTripFails) throw new Error('round_trip wird von diesem Plan nicht unterstützt');

    const r = distanceM / (2 * Math.PI);
    const mitte = destination(start, 0, r);
    const coords = [];
    for (let i = 0; i <= 120; i++) {
      const p = destination(mitte, 180 + i * 3, r);
      coords.push([p[0], p[1], 400 + 150 * Math.sin(i / 8)]);
    }
    const laenge = lineLength(coords);
    return {
      coords,
      distanceM: laenge,
      routerTimeS: laenge / 16,
      ascentM: Math.round((laenge / 1000) * 10),
      provider: 'fake',
      profileUsed: 'fake round_trip',
    };
  }

  async route(points, { nogos = [] } = {}) {
    try {
      return await this.#fahre(points, nogos);
    } catch (err) {
      // Denselben Rueckfall wie der echte BRouter-Adapter: machen die
      // Sperrzonen eine Route unmoeglich, lieber eine Route mit Maut oder
      // Autobahn als gar keine. Ohne das misst der Pruefstand einen
      // Ausfall, den es in der App nicht gibt.
      if (nogos.length && err.kind === 'unreachable') {
        this.sperrenGefallen++;
        const route = await this.#fahre(points, []);
        return { ...route, tollBlockLifted: true };
      }
      throw err;
    }
  }

  async #fahre(points, nogos) {
    this.calls++;
    const grenze = this.echterGrenzwert ?? this.maxPoints;
    if (points.length > grenze) {
      this.zuVielePunkte++;
      throw new RoutingError(
        `Dein Tarif erlaubt nur ${grenze} Punkte je Anfrage.`,
        { provider: 'fake', kind: 'too-many-points', maxPoints: grenze },
      );
    }
    for (let i = 0; i < points.length; i++) {
      const abseits =
        this.corridors.length > 0 &&
        !this.corridors.some((c) => distance(points[i], c) < this.corridorWidthM);
      const island = abseits
        ? { center: points[i] }
        : this.islands.find((is) => distance(points[i], is.center) < is.radiusM);
      if (island) {
        this.rejections++;
        // Denselben Weg nehmen wie der echte Adapter: Servertext -> Klartext.
        const info = classifyBRouterMessage(`target island detected for section ${i}`);
        throw new RoutingError(info.message, {
          provider: 'fake',
          kind: info.kind,
          section: info.section,
        });
      }
    }
    // Wegpunkte in Sackgassentaelern zwingen zur Rueckfahrt auf demselben Weg.
    const path = [];
    for (let i = 0; i < points.length; i++) {
      path.push(points[i]);
      const inValley =
        i > 0 &&
        i < points.length - 1 &&
        this.deadEnds.some((d) => distance(points[i], d.center) < d.radiusM);
      if (inValley) path.push(points[i - 1]);
    }

    // Sperrzonen gelten nur auf dem echten Graphen -- ohne Netz gibt es
    // nichts, um das man herumfahren koennte.
    const gesperrt = this.graph ? this.graph.gesperrteKnoten(nogos) : null;
    const coords = [];
    for (let i = 1; i < path.length; i++) {
      const seg = this.graph
        ? this.#graphSegment(path[i - 1], path[i], i, gesperrt)
        : this.#segment(path[i - 1], path[i]);
      coords.push(...(i === 1 ? seg : seg.slice(1)));
    }
    const distanceM = lineLength(coords);
    return {
      coords,
      distanceM,
      routerTimeS: distanceM / 16,
      ascentM: Math.round((distanceM / 1000) * 12),
      provider: 'fake',
      profileUsed: 'fake',
    };
  }

  /** Ein Abschnitt entlang des echten Netzes. */
  #graphSegment(a, b, section, gesperrt) {
    const va = this.graph.naechster(a);
    const vb = this.graph.naechster(b);
    const pfad = va.key && vb.key ? this.graph.weg(va.key, vb.key, gesperrt) : null;
    if (!pfad) {
      this.rejections++;
      const info = classifyBRouterMessage(`target island detected for section ${section}`);
      throw new RoutingError(info.message, {
        provider: 'fake',
        kind: info.kind,
        section: info.section,
      });
    }
    return pfad;
  }

  #segment(a, b) {
    const len = distance(a, b);
    const steps = Math.max(2, Math.round(len / this.stepM));
    const heading = headingOf(a, b);
    const waves = Math.max(1, Math.round(len / 900));
    const wellenlaenge = len / waves;
    // Amplitude an die Wellenlaenge koppeln: sonst entsteht ein Zickzack,
    // das keine Strasse je faehrt.
    const amp = this.wiggle * Math.min(wellenlaenge / 8, len * 0.08);
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const base = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const offset = amp * Math.sin(2 * Math.PI * waves * t);
      const p = destination(base, heading + 90, offset);
      out.push([p[0], p[1], 300 + 120 * Math.sin(6 * Math.PI * t)]);
    }
    return out;
  }
}

function headingOf(a, b) {
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
