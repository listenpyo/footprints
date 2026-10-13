/* maplibre-gl-leaflet 어댑터가 `import * as L from "leaflet"` 로 Leaflet 을 요구한다.
 * 페이지에 이미 전역으로 올라간 Leaflet(window.L)을 그대로 넘겨 Leaflet 이 두 벌 생기지 않게 한다. */
const L = window.L;
export default L;
export const { Layer, DomUtil, DomEvent, Util, Browser, setOptions, extend, point, latLng, latLngBounds, Bounds, Point, LatLng, LatLngBounds, Map } = L;
