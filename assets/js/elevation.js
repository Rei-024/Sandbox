/**
 * Hoehenprofil als Inline-SVG.
 *
 * Eine Datenreihe (Hoehe ueber Distanz), also bewusst ohne Legende -- die
 * Ueberschrift benennt sie. Gitter und Achsen sind duenne, durchgezogene
 * Hilfslinien; beschriftet wird nur der hoechste Punkt. Alles andere holt
 * man sich ueber den Fadenkreuz-Tooltip oder die Tabellenansicht.
 */

const PAD = { top: 16, right: 16, bottom: 26, left: 48 };
const HEIGHT = 178;
const MAX_POINTS = 400;
const MIN_SPAN_M = 40; // flaches Profil nicht kuenstlich dramatisieren

export class ElevationChart {
  /**
   * @param {HTMLElement} container
   * @param {{onHover?: (index: number|null) => void}} options
   */
  constructor(container, { onHover } = {}) {
    this.container = container;
    this.onHover = onHover ?? (() => {});
    this.points = [];
    this.pressed = false;

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'elevation__svg');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('tabindex', '0');
    this.container.append(this.svg);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'elevation__tooltip';
    this.tooltip.hidden = true;
    this.container.append(this.tooltip);

    this.#bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.#render());
    this.resizeObserver.observe(this.container);
  }

  /** @param {Array<[number, number, number?]>} coords Routenpunkte mit Hoehe */
  setData(coords, cumulativeM) {
    const pts = [];
    for (let i = 0; i < coords.length; i++) {
      const ele = coords[i][2];
      if (Number.isFinite(ele)) pts.push({ km: cumulativeM[i] / 1000, ele, index: i });
    }
    this.points = downsample(pts, MAX_POINTS);
    this.#render();
    return this.points.length > 1;
  }

  clear() {
    this.points = [];
    this.svg.replaceChildren();
    this.tooltip.hidden = true;
  }

  /** Zeilen fuer die Tabellenansicht -- damit jeder Wert auch ohne Hover lesbar ist. */
  tableRows(count = 11) {
    if (this.points.length < 2) return [];
    const last = this.points[this.points.length - 1];
    const rows = [];
    for (let i = 0; i < count; i++) {
      const km = (last.km * i) / (count - 1);
      const p = this.#nearestByKm(km);
      const prev = rows[rows.length - 1];
      const slope = prev && p.km > prev.km ? ((p.ele - prev.ele) / ((p.km - prev.km) * 1000)) * 100 : 0;
      rows.push({ km: p.km, ele: p.ele, slope });
    }
    return rows;
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  /* --------------------------------------------------------------- intern */

  #render() {
    const width = Math.max(240, this.container.clientWidth);
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(HEIGHT));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    this.svg.replaceChildren();

    const pts = this.points;
    if (pts.length < 2) return;

    const totalKm = pts[pts.length - 1].km;
    let lo = Math.min(...pts.map((p) => p.ele));
    let hi = Math.max(...pts.map((p) => p.ele));
    if (hi - lo < MIN_SPAN_M) {
      const mid = (hi + lo) / 2;
      lo = mid - MIN_SPAN_M / 2;
      hi = mid + MIN_SPAN_M / 2;
    }
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    this.scale = {
      x: (km) => PAD.left + (km / totalKm) * plotW,
      y: (ele) => PAD.top + plotH - ((ele - lo) / (hi - lo)) * plotH,
      totalKm,
      plotW,
      plotH,
    };

    this.svg.setAttribute(
      'aria-label',
      `Hoehenprofil ueber ${totalKm.toFixed(1)} Kilometer, ` +
        `zwischen ${Math.round(lo)} und ${Math.round(hi)} Metern.`,
    );

    const g = (cls) => {
      const el = document.createElementNS(SVG_NS, 'g');
      el.setAttribute('class', cls);
      this.svg.append(el);
      return el;
    };

    // Gitter und Achsen -- Haarlinien, durchgezogen, im Hintergrund.
    const grid = g('elevation__grid');
    for (const tick of niceTicks(lo, hi, 4)) {
      const y = this.scale.y(tick);
      grid.append(
        line(PAD.left, y, width - PAD.right, y, 'elevation__gridline'),
        text(PAD.left - 8, y + 4, `${Math.round(tick)}`, 'elevation__tick elevation__tick--y'),
      );
    }
    for (const tick of niceTicks(0, totalKm, 5)) {
      if (tick <= 0) continue;
      const x = this.scale.x(tick);
      grid.append(
        text(x, HEIGHT - PAD.bottom + 17, formatKm(tick), 'elevation__tick elevation__tick--x'),
      );
    }
    grid.append(
      line(PAD.left, HEIGHT - PAD.bottom, width - PAD.right, HEIGHT - PAD.bottom, 'elevation__axis'),
      text(PAD.left - 8, PAD.top - 5, 'm', 'elevation__tick elevation__tick--y elevation__unit'),
    );
    // Einheit der x-Achse links unter den Nullpunkt -- der erste Strich liegt
    // immer deutlich weiter rechts, da kollidiert nichts.
    const kmLabel = text(PAD.left, HEIGHT - PAD.bottom + 17, 'km', 'elevation__tick elevation__unit');
    kmLabel.setAttribute('text-anchor', 'start');
    grid.append(kmLabel);

    // Flaeche und Linie.
    const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${this.scale.x(p.km).toFixed(1)} ${this.scale.y(p.ele).toFixed(1)}`).join(' ');
    const base = HEIGHT - PAD.bottom;
    const area = document.createElementNS(SVG_NS, 'path');
    area.setAttribute('class', 'elevation__area');
    area.setAttribute(
      'd',
      `${linePath} L${this.scale.x(totalKm).toFixed(1)} ${base} L${PAD.left} ${base} Z`,
    );
    const stroke = document.createElementNS(SVG_NS, 'path');
    stroke.setAttribute('class', 'elevation__line');
    stroke.setAttribute('d', linePath);
    this.svg.append(area, stroke);

    // Nur der hoechste Punkt bekommt eine feste Beschriftung.
    const peak = pts.reduce((a, b) => (b.ele > a.ele ? b : a), pts[0]);
    const px = this.scale.x(peak.km);
    const py = this.scale.y(peak.ele);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'elevation__peak');
    dot.setAttribute('cx', px.toFixed(1));
    dot.setAttribute('cy', py.toFixed(1));
    dot.setAttribute('r', '3.5');
    const anchor = px > width - 90 ? 'end' : 'start';
    const label = text(
      px + (anchor === 'end' ? -8 : 8),
      Math.max(PAD.top + 4, py - 8),
      `${Math.round(peak.ele)} m`,
      'elevation__peak-label',
    );
    label.setAttribute('text-anchor', anchor);
    this.svg.append(dot, label);

    this.cursor = document.createElementNS(SVG_NS, 'g');
    this.cursor.setAttribute('class', 'elevation__cursor');
    this.cursor.setAttribute('visibility', 'hidden');
    this.cursorLine = line(0, PAD.top, 0, base, 'elevation__crosshair');
    this.cursorDot = document.createElementNS(SVG_NS, 'circle');
    this.cursorDot.setAttribute('r', '4.5');
    this.cursorDot.setAttribute('class', 'elevation__cursor-dot');
    this.cursor.append(this.cursorLine, this.cursorDot);
    this.svg.append(this.cursor);
  }

  #bindPointer() {
    const move = (event) => {
      if (event.pointerType === 'touch' && !this.pressed) return;
      const rect = this.svg.getBoundingClientRect();
      this.#moveCursorToX(event.clientX - rect.left);
    };
    this.svg.addEventListener('pointerdown', (e) => {
      this.pressed = true;
      move(e);
    });
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerup', () => {
      this.pressed = false;
    });
    this.svg.addEventListener('pointerleave', () => {
      this.pressed = false;
      this.#hideCursor();
    });
    this.svg.addEventListener('blur', () => this.#hideCursor());
    this.svg.addEventListener('keydown', (event) => {
      if (!this.points.length) return;
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const dir = event.key === 'ArrowRight' ? step : -step;
        this.cursorIndex = clampInt((this.cursorIndex ?? 0) + dir, 0, this.points.length - 1);
        this.#showCursorAt(this.points[this.cursorIndex]);
      } else if (event.key === 'Escape') {
        this.#hideCursor();
      }
    });
  }

  #moveCursorToX(x) {
    if (!this.scale || this.points.length < 2) return;
    const km = ((x - PAD.left) / this.scale.plotW) * this.scale.totalKm;
    const p = this.#nearestByKm(km);
    this.cursorIndex = this.points.indexOf(p);
    this.#showCursorAt(p);
  }

  #showCursorAt(p) {
    if (!p || !this.cursor) return;
    const x = this.scale.x(p.km);
    const y = this.scale.y(p.ele);
    this.cursorLine.setAttribute('x1', x);
    this.cursorLine.setAttribute('x2', x);
    this.cursorDot.setAttribute('cx', x);
    this.cursorDot.setAttribute('cy', y);
    this.cursor.setAttribute('visibility', 'visible');

    this.tooltip.hidden = false;
    this.tooltip.innerHTML =
      `<strong>${Math.round(p.ele)} m</strong><span>bei ${formatKm(p.km)} km</span>`;
    const w = this.tooltip.offsetWidth;
    const maxLeft = this.container.clientWidth - w - 4;
    this.tooltip.style.left = `${Math.min(Math.max(4, x - w / 2), Math.max(4, maxLeft))}px`;
    this.tooltip.style.top = `${Math.max(2, y - 46)}px`;

    this.onHover(p.index);
  }

  #hideCursor() {
    this.cursor?.setAttribute('visibility', 'hidden');
    this.tooltip.hidden = true;
    this.onHover(null);
  }

  #nearestByKm(km) {
    let lo = 0;
    let hi = this.points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].km < km) lo = mid;
      else hi = mid;
    }
    return Math.abs(this.points[lo].km - km) <= Math.abs(this.points[hi].km - km)
      ? this.points[lo]
      : this.points[hi];
  }
}

/* ------------------------------------------------------------- Helferlein */

const SVG_NS = 'http://www.w3.org/2000/svg';

function line(x1, y1, x2, y2, cls) {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', x1);
  el.setAttribute('y1', y1);
  el.setAttribute('x2', x2);
  el.setAttribute('y2', y2);
  el.setAttribute('class', cls);
  return el;
}

function text(x, y, content, cls) {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.setAttribute('class', cls);
  el.textContent = content;
  return el;
}

/** Gleichmaessig ausduennen -- fuer die Darstellung reichen ein paar hundert Punkte. */
export function downsample(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const stride = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

/**
 * "Runde" Achsenwerte statt 412.7, 508.3, ... Es wird die feinste huebsche
 * Schrittweite genommen, die noch hoechstens `count`+1 Striche ergibt.
 */
export function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const steps = [0.5, 1, 2, 2.5, 5, 10, 20].map((m) => m * mag);
  const step =
    steps.find((s) => Math.floor(hi / s) - Math.ceil(lo / s) + 1 <= count + 1) ??
    steps[steps.length - 1];
  const ticks = [];
  for (let i = Math.ceil(lo / step); i * step <= hi + 1e-9; i++) {
    ticks.push(Number((i * step).toFixed(6)));
  }
  return ticks.length ? ticks : [Number(((lo + hi) / 2).toFixed(6))];
}

const formatKm = (km) => (km >= 100 ? km.toFixed(0) : km.toFixed(km >= 10 ? 0 : 1));
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
