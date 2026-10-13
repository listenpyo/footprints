/* 오프라인 대비 서비스 워커.
 *  - 앱 셸(HTML/CSS/JS)은 네트워크 우선, 실패 시 캐시 (통신 없어도 열림).
 *  - 지도 타일은 네트워크 우선, 실패 시 캐시 (최근 본 지역은 통신이 끊겨도 보임). 타일 캐시는 2000장까지.
 *  - Overpass / Firebase 요청은 캐시하지 않는다.
 */
const SHELL = 'fm-shell-v1';
const TILES = 'fm-tiles-v1';
const SHELL_FILES = ['./', './index.html', './css/app.css', './js/i18n.js', './js/geo.js', './js/store.js', './js/estimate.js', './js/sync.js', './js/route.js', './js/app.js', './manifest.webmanifest', './icon.svg',
  './js/leaflet-esm-shim.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@6.3.0/dist/maplibre-gl.css'];
const TILE_HOSTS = ['tiles.openfreemap.org', 'cyberjapandata.gsi.go.jp', 'tile.openstreetmap.org'];
const MAX_TILES = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.includes(url.host)) {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(TILES).then(c => c.put(e.request, copy).then(() => trimTiles(c))); } return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  if (url.host.includes('overpass') || url.host.includes('firebase') || url.host.includes('gstatic')) return;
  // 앱 셸은 네트워크 우선(새 버전이 바로 반영), 실패하면 캐시.
  // 같은 출처 파일은 항상 서버에 재확인(cache:'no-cache')해서 수정이 바로 반영되게 한다.
  const req = url.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(req).then(r => { if (r.ok && (url.origin === location.origin || url.host === 'cdnjs.cloudflare.com' || url.host === 'cdn.jsdelivr.net')) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request)));
});
let trimming = false;
async function trimTiles(cache) {
  if (trimming) return; trimming = true;
  try { const keys = await cache.keys(); if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k); }
  finally { trimming = false; }
}
