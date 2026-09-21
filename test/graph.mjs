/**
 * Ein Strassengraph fuer den Testrouter.
 *
 * Bis hierher hat der simulierte Router eine geschlaengelte Linie von einem
 * Wegpunkt zum naechsten gezeichnet. Das reicht, um Laengen, Kurvigkeit und
 * Hoehen zu pruefen -- aber es kann zwei Dinge nicht: eine Sackgasse, aus
 * der man nur auf demselben Weg herauskommt, und eine Acht, weil der
 * einzige Uebergang zwischen zwei Gegenden durch den Startort fuehrt.
 *
 * Beides sind genau die Beschwerden aus der Wirklichkeit. Ein Pruefstand,
 * der sie nicht erzeugen kann, meldet fuer sie immer null.
 *
 * Deshalb hier ein richtiger Graph: die gezeichneten Strassen werden in ein
 * Raster einsortiert (eine Zelle = ein Knoten), Nachbarzellen entlang einer
 * Strasse werden zu Kanten, und gefahren wird mit Dijkstra. Was nicht
 * verbunden ist, ist dann wirklich nicht erreichbar.
 */
import { distance } from '../assets/js/geo.js';

const ZELL_M = 60;

class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(kosten, wert) {
    const a = this.a;
    a.push([kosten, wert]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let k = i;
        if (l < a.length && a[l][0] < a[k][0]) k = l;
        if (r < a.length && a[r][0] < a[k][0]) k = r;
        if (k === i) break;
        [a[k], a[i]] = [a[i], a[k]];
        i = k;
      }
    }
    return top;
  }
}

export class RoadGraph {
  /**
   * @param {Array<[number[], number[]]>} kanten Punktpaare entlang der Strassen.
   *        Jeder Punkt ist [lon, lat] oder [lon, lat, hoehe].
   */
  constructor(kanten, zellM = ZELL_M) {
    this.zellM = zellM;
    this.punkte = new Map(); // key -> [lon, lat, hoehe]
    this.nachbarn = new Map(); // key -> Map(key -> Meter)
    this.refLat = kanten.length ? kanten[0][0][1] : 0;
    this.cosLat = Math.max(0.2, Math.cos((this.refLat * Math.PI) / 180));
    for (const [a, b] of kanten) this.#kante(a, b);
    this.keys = [...this.punkte.keys()];
  }

  #key(p) {
    const y = Math.round((p[1] * 111320) / this.zellM);
    const x = Math.round((p[0] * 111320 * this.cosLat) / this.zellM);
    return `${y}:${x}`;
  }

  #kante(a, b) {
    const ka = this.#key(a);
    const kb = this.#key(b);
    if (!this.punkte.has(ka)) this.punkte.set(ka, a);
    if (!this.punkte.has(kb)) this.punkte.set(kb, b);
    if (ka === kb) return;
    const d = distance(a, b);
    for (const [von, nach] of [
      [ka, kb],
      [kb, ka],
    ]) {
      if (!this.nachbarn.has(von)) this.nachbarn.set(von, new Map());
      const m = this.nachbarn.get(von);
      if (!(m.get(nach) <= d)) m.set(nach, d);
    }
  }

  /** Naechstgelegener Knoten zu einem beliebigen Punkt. */
  naechster(p) {
    let best = null;
    let bestD = Infinity;
    for (const k of this.keys) {
      const d = distance(this.punkte.get(k), p);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return { key: best, abstandM: bestD };
  }

  /**
   * Kuerzester Weg entlang der Strassen. Gibt null zurueck, wenn es keinen
   * gibt -- getrennte Netzteile sind im Gebirge die Regel, nicht die
   * Ausnahme.
   */
  /**
   * Knoten, die in einer Sperrzone liegen. [lon, lat, radius] je Zone --
   * dasselbe Format, das BRouter entgegennimmt.
   */
  gesperrteKnoten(nogos) {
    const raus = new Set();
    if (!nogos?.length) return raus;
    for (const k of this.keys) {
      const p = this.punkte.get(k);
      for (const [lon, lat, radius] of nogos) {
        if (distance(p, [lon, lat]) <= radius) {
          raus.add(k);
          break;
        }
      }
    }
    return raus;
  }

  weg(vonKey, nachKey, gesperrt = null) {
    if (gesperrt?.size && (gesperrt.has(vonKey) || gesperrt.has(nachKey))) return null;
    if (vonKey === nachKey) return [this.punkte.get(vonKey)];
    const dist = new Map([[vonKey, 0]]);
    const vor = new Map();
    const heap = new Heap();
    heap.push(0, vonKey);
    const fertig = new Set();
    while (heap.size) {
      const [d, k] = heap.pop();
      if (fertig.has(k)) continue;
      fertig.add(k);
      if (k === nachKey) break;
      for (const [n, kosten] of this.nachbarn.get(k) ?? []) {
        if (fertig.has(n) || gesperrt?.has(n)) continue;
        const neu = d + kosten;
        if (neu < (dist.get(n) ?? Infinity)) {
          dist.set(n, neu);
          vor.set(n, k);
          heap.push(neu, n);
        }
      }
    }
    if (!fertig.has(nachKey)) return null;
    const pfad = [];
    for (let k = nachKey; k != null; k = vor.get(k)) {
      pfad.push(this.punkte.get(k));
      if (k === vonKey) break;
    }
    return pfad.reverse();
  }
}
