/** Duenne Huelle um Leaflet -- haelt den Kartenkram aus der App-Logik raus. */

import { toLatLng, toLatLngs } from './geo.js';

const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';

export class MapView {
  constructor(element, { onMapClick, onStartDrag, onEndDrag, onCandidatePick } = {}) {
    this.onCandidatePick = onCandidatePick ?? (() => {});
    this.map = L.map(element, { zoomControl: true, attributionControl: true });
    this.map.setView([48.4636, 8.4117], 10);

    const strasse = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: TILE_ATTRIB,
    });
    const gelaende = L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: `${TILE_ATTRIB}, SRTM | Kartendarstellung: <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    });
    strasse.addTo(this.map);
    L.control.layers({ Strasse: strasse, 'Gelände': gelaende }, {}, { position: 'topright' }).addTo(this.map);

    this.routeLayer = L.layerGroup().addTo(this.map);
    this.altLayer = L.layerGroup().addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);

    this.onStartDrag = onStartDrag ?? (() => {});
    this.onEndDrag = onEndDrag ?? (() => {});
    this.map.on('click', (e) => onMapClick?.([e.latlng.lng, e.latlng.lat]));
  }

  invalidate() {
    setTimeout(() => this.map.invalidateSize(), 0);
  }

  setStart(point) {
    this.startMarker = this.#pin(this.startMarker, point, 'start', 'Start', this.onStartDrag);
  }

  setEnd(point) {
    if (!point) {
      if (this.endMarker) {
        this.markerLayer.removeLayer(this.endMarker);
        this.endMarker = null;
      }
      return;
    }
    this.endMarker = this.#pin(this.endMarker, point, 'end', 'Ziel', this.onEndDrag);
  }

  #pin(existing, point, kind, label, onDrag) {
    const latlng = toLatLng(point);
    if (existing) {
      existing.setLatLng(latlng);
      return existing;
    }
    const marker = L.marker(latlng, {
      draggable: true,
      keyboard: true,
      title: `${label} (verschiebbar)`,
      icon: L.divIcon({
        className: '',
        html: `<span class="map-pin map-pin--${kind}" aria-hidden="true"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    });
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      onDrag([p.lng, p.lat]);
    });
    marker.addTo(this.markerLayer);
    return marker;
  }

  /** Hauptroute zeichnen; die uebrigen Kandidaten blass daneben. */
  showRoute(candidate, alternatives = []) {
    this.routeLayer.clearLayers();
    this.altLayer.clearLayers();

    for (const alt of alternatives) {
      if (alt.id === candidate.id) continue;
      const poly = L.polyline(toLatLngs(alt.coords), {
        className: 'route-line route-line--alt',
        weight: 3,
        opacity: 0.55,
        interactive: true,
      });
      poly.bindTooltip(`Variante ${alt.rank}: ${Math.round(alt.distanceM / 1000)} km`);
      poly.on('click', (e) => {
        L.DomEvent.stop(e);
        this.onCandidatePick(alt.id);
      });
      poly.addTo(this.altLayer);
    }

    const latlngs = toLatLngs(candidate.coords);
    L.polyline(latlngs, { className: 'route-line route-line--casing', weight: 8 }).addTo(this.routeLayer);
    L.polyline(latlngs, { className: 'route-line route-line--main', weight: 4 }).addTo(this.routeLayer);
    this.map.fitBounds(L.latLngBounds(latlngs).pad(0.08));
  }

  clearRoute() {
    this.routeLayer.clearLayers();
    this.altLayer.clearLayers();
    this.hoverAt(null);
  }

  /** Punkt auf der Route markieren (kommt vom Hoehenprofil). */
  hoverAt(point) {
    if (!point) {
      if (this.hoverMarker) {
        this.markerLayer.removeLayer(this.hoverMarker);
        this.hoverMarker = null;
      }
      return;
    }
    const latlng = toLatLng(point);
    if (this.hoverMarker) this.hoverMarker.setLatLng(latlng);
    else {
      this.hoverMarker = L.circleMarker(latlng, {
        radius: 6,
        className: 'route-hover',
        interactive: false,
      }).addTo(this.markerLayer);
    }
  }

  focus(point, zoom = 12) {
    this.map.setView(toLatLng(point), Math.max(this.map.getZoom(), zoom));
  }
}
