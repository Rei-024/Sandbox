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
   */
  constructor({ wiggle = 0.5, stepM = 120, islands = [], deadEnds = [] } = {}) {
    this.wiggle = wiggle;
    this.stepM = stepM;
    this.islands = islands;
    this.deadEnds = deadEnds;
    this.calls = 0;
    this.rejections = 0;
    this.provider = 'fake';
  }

  async route(points) {
    this.calls++;
    for (let i = 0; i < points.length; i++) {
      const island = this.islands.find((is) => distance(points[i], is.center) < is.radiusM);
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

    const coords = [];
    for (let i = 1; i < path.length; i++) {
      const seg = this.#segment(path[i - 1], path[i]);
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

  #segment(a, b) {
    const len = distance(a, b);
    const steps = Math.max(2, Math.round(len / this.stepM));
    const heading = headingOf(a, b);
    const amp = this.wiggle * Math.min(400, len * 0.08);
    const waves = Math.max(1, Math.round(len / 900));
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
