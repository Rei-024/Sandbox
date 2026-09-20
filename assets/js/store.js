/**
 * Einstellungen im Browser merken. Bewusst nur localStorage -- die App hat
 * kein Backend, es verlaesst also nichts das Geraet. Der GraphHopper-Key
 * liegt damit im Browser-Speicher; das steht auch so in der Oberflaeche.
 */

const KEY = 'kurvenjagd.settings.v1';

export const DEFAULTS = {
  start: null, // [lon, lat]
  startLabel: '',
  home: null,
  homeLabel: '',
  mode: 'loop',
  durationMin: 120,
  curviness: 4,
  bearing: null, // null = Richtung egal
  variants: 3,
  avoidMotorway: true,
  avoidUnpaved: true,
  snapToRoads: true,
  provider: 'brouter',
  brouterProfile: 'auto',
  brouterUrl: '',
  graphhopperKey: '',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* Privater Modus o.ae. -- dann eben ohne Merken. */
  }
}
