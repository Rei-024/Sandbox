/**
 * Das Bedienblatt am unteren Rand.
 *
 * Drei Rasten: zugeklappt zeigt es nur die Zusammenfassung und den grossen
 * Knopf, halb offen Ergebnis und Karte nebeneinander, ganz offen das volle
 * Formular. Ziehen am Griff waehlt die naechstliegende Raste, Antippen
 * schaltet weiter.
 *
 * Eine Raste ist eine Hoehe, keine Verschiebung. Das ist der Unterschied
 * zwischen "zugeklappt heisst, der grosse Knopf ist noch da" und
 * "zugeklappt heisst, der grosse Knopf ist unten aus dem Bild geschoben".
 *
 * Am Rechner gibt es das nicht: dort ist das Blatt eine feste Seitenspalte,
 * erkennbar daran, dass der Griff ausgeblendet ist.
 */

const RASTEN = ['peek', 'half', 'full'];

export class Sheet {
  /**
   * @param {HTMLElement} el      das Blatt
   * @param {HTMLElement} handle  Griffleiste
   * @param {HTMLElement} actions Knopfleiste am Fuss
   */
  constructor(el, handle, actions, { onChange } = {}) {
    this.el = el;
    this.handle = handle;
    this.actions = actions;
    this.onChange = onChange ?? (() => {});
    this.state = 'peek';
    this.dragging = null;

    this.#bind();
    this.apply();
    new ResizeObserver(() => this.apply()).observe(el);
  }

  /** Ist das Blatt gerade eine Seitenspalte? Dann tut sich hier nichts. */
  get istSeitenspalte() {
    return getComputedStyle(this.handle).display === 'none';
  }

  /** Groesste zulaessige Hoehe -- dasselbe Limit wie max-height im Stil. */
  get maxHoehe() {
    return Math.min(window.innerHeight * 0.86, 900);
  }

  /** Hoehe je Raste, in Pixeln. */
  heightFor(state) {
    // In der Raste "peek" faellt die Polsterung des Scrollbereichs weg
    // (siehe Stil), sichtbar bleiben genau Griff und Knopfleiste.
    const zu = this.handle.offsetHeight + this.actions.offsetHeight;
    if (state === 'full') return this.maxHoehe;
    if (state === 'half') return Math.min(this.maxHoehe, Math.max(zu, window.innerHeight * 0.52));
    return Math.min(this.maxHoehe, zu);
  }

  apply() {
    this.el.dataset.state = this.state;
    if (this.istSeitenspalte) {
      this.el.style.removeProperty('--sheet-h');
      return;
    }
    this.el.style.setProperty('--sheet-h', `${this.heightFor(this.state)}px`);
  }

  setState(state) {
    if (!RASTEN.includes(state) || this.state === state) return;
    this.state = state;
    this.apply();
    this.onChange(state);
  }

  /** Mindestens so weit oeffnen, ohne ein weiter offenes Blatt zuzuklappen. */
  openAtLeast(state) {
    if (RASTEN.indexOf(state) > RASTEN.indexOf(this.state)) this.setState(state);
  }

  weiter() {
    const i = RASTEN.indexOf(this.state);
    this.setState(RASTEN[(i + 1) % RASTEN.length]);
  }

  #bind() {
    const onDown = (e) => {
      if (this.istSeitenspalte) return;
      this.dragging = { y: e.clientY, start: this.heightFor(this.state), bewegt: 0 };
      this.el.classList.add('is-dragging');
      this.handle.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!this.dragging) return;
      const dy = e.clientY - this.dragging.y;
      this.dragging.bewegt = Math.max(this.dragging.bewegt, Math.abs(dy));
      // Nach oben ziehen (dy negativ) macht das Blatt groesser.
      const ziel = Math.min(this.maxHoehe, Math.max(this.heightFor('peek'), this.dragging.start - dy));
      this.el.style.setProperty('--sheet-h', `${ziel}px`);
    };
    const onUp = (e) => {
      if (!this.dragging) return;
      const { bewegt } = this.dragging;
      this.dragging = null;
      this.el.classList.remove('is-dragging');
      this.handle.releasePointerCapture?.(e.pointerId);

      // Kaum bewegt? Dann war es ein Tippen.
      if (bewegt < 8) {
        this.weiter();
        return;
      }
      const jetzt = parseFloat(this.el.style.getPropertyValue('--sheet-h')) || this.heightFor(this.state);
      const naechste = RASTEN.reduce((a, b) =>
        Math.abs(this.heightFor(b) - jetzt) < Math.abs(this.heightFor(a) - jetzt) ? b : a,
      );
      this.state = naechste;
      this.apply();
      this.onChange(naechste);
    };

    this.handle.addEventListener('pointerdown', onDown);
    this.handle.addEventListener('pointermove', onMove);
    this.handle.addEventListener('pointerup', onUp);
    this.handle.addEventListener('pointercancel', onUp);
    this.handle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.weiter();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setState(RASTEN[Math.min(RASTEN.length - 1, RASTEN.indexOf(this.state) + 1)]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.setState(RASTEN[Math.max(0, RASTEN.indexOf(this.state) - 1)]);
      }
    });
  }
}
