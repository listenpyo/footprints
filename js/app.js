/* 발자취 — 전단지 배포 팀 실시간 지도. 메인 앱. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0ea5e9', '#f032e6', '#9a6324', '#0d9488', '#64748b'];
const HARIMA = [34.7165, 134.868]; // 兵庫県加古郡播磨町 중심 부근
// 벡터 기본지도: OpenFreeMap (무료·키 없음·횟수 제한 없음, OSM 데이터). 구글·네이버 지도처럼 읽기 쉽다.
const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · 建物・道路: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>を加工';
// 건물 윤곽은 OSM 대신 국토지리원 基盤地図情報(전수)로 그린다. OSM 은 播磨町에서 건물의 절반 가까이가 빠져 주택가가 비어 보인다.
const GSI_BVMAP_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf';
const VECTOR = {
  ofm_liberty: { style: 'https://tiles.openfreemap.org/styles/liberty' },   // 구글풍, 건물·상호 표시
  ofm_bright: { style: 'https://tiles.openfreemap.org/styles/bright' },     // 조금 더 선명
  ofm_positron: { style: 'https://tiles.openfreemap.org/styles/positron' }, // 거의 흑백 — 발자취·구역 색이 가장 잘 보임
};
// 래스터 예비 지도 (벡터 지도를 못 읽는 오래된 기기용)
const TILES = {
  gsi_pale: { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>', maxNativeZoom: 18 },
  gsi_std: { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>', maxNativeZoom: 18 },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors', maxNativeZoom: 19 },
};
const OSM_ATTR = '건물·길 데이터 &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL)';
const POI_TYPES = { refuse: '🚫', autolock: '🔒', done: '✅', note: '📝' };
const STALE_MS = 90 * 1000;      // 이 시간 동안 수신 없으면 '오프라인' 표시
const FLUSH_MS = 4000;           // 궤적 점을 묶어서 보내는 간격

// ---------- 상태 ----------
const S = {
  me: null, code: null, sess: null,
  members: {},            // id -> presence (나 제외)
  tracks: {},             // id -> [{lat,lng,t,acc,ov?}]  (나 포함)
  coverage: {},           // segKey -> memberId (처음 지나간 사람)
  passes: {},             // segKey -> { memberId: [t, ...] }  통과 시각. 왕복하면 여러 개 쌓인다.
  lastHit: {},            // segKey|memberId -> t  (같은 통과를 여러 번 세지 않기 위한 메모리)
  stride: 70,             // 보폭 cm
  tracking: false, watchId: null, lastPt: null, myPos: null, wakeLock: null,
  draw: null, poiMode: null, routeMode: null, pinMode: null, nav: null,   // nav: {zoneId, pos}  경로 안내 진행 상태
  follow: false,                                            // 내 위치를 화면 중앙에 계속 유지
  layers: { route: true, steps: true, myTrack: true, otherTracks: true, streets: true, blds: true, pois: true, zones: true, members: true },
  sim: false, lang: 'ko', tile: 'gsi_pale', syncKind: 'local', firebaseCfg: null,
  ovRadius: 15, coverRadius: 12,
  sync: null, bots: [], botTimer: null, pending: [], flushTimer: null, lastOvToast: 0, ovMeters: 0,
  grid: new Geo.Grid(),   // 다른 팀원 궤적 점 색인
  estQueue: [], estBusy: false,
};

// ---------- 지도 ----------
let map, tileLayer;
const LG = { zones: L.layerGroup(), bld: L.layerGroup(), streets: L.layerGroup(), tracks: L.layerGroup(), route: L.layerGroup(), members: L.layerGroup(), pois: L.layerGroup(), draw: L.layerGroup() };
const trackLayers = {};   // memberId -> {halo, core, ov:[]}
const memberMarkers = {}; // memberId -> marker
const segLayers = {};     // segKey -> polyline
let myMarker = null;

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView(HARIMA, 15);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  setTile(S.tile);
  Object.values(LG).forEach(g => g.addTo(map));
  map.attributionControl.addAttribution(OSM_ATTR);
  map.on('click', onMapClick);
  map.on('zoomend', () => { updateHaloWeights(); renderRoutes(); });
  map.on('dragstart', () => setFollow(false));   // 손으로 지도를 움직이면 따라가기 해제
  const view = Store.get('view');
  if (view) map.setView(view.c, view.z);
  map.on('moveend', () => Store.set('view', { c: map.getCenter(), z: map.getZoom() }));
}
function setTile(key) {
  if (!TILES[key] && !VECTOR[key]) key = 'ofm_liberty';
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  S.tile = key;
  if (VECTOR[key]) {
    ensureMaplibre().then(maplibreGL => {
      if (S.tile !== key) return;
      tileLayer = maplibreGL({ style: VECTOR[key].style, attributionControl: { customAttribution: OFM_ATTR }, pane: 'tilePane' }).addTo(map);
      localizeLabels(tileLayer);
      // 캔버스가 처음 그려지기 전에 크기가 잡히면 빈 화면으로 남는 경우가 있어 한 번 더 크기를 맞춘다.
      const gm = tileLayer.getMaplibreMap();
      // setView(reset) 으로 Leaflet 이 zoom/move 이벤트를 다시 쏘게 해서 어댑터가 캔버스 위치·줌을 재계산하게 한다.
      const kick = () => { if (gm && tileLayer && tileLayer.getMaplibreMap() === gm) { gm.resize(); map.setView(map.getCenter(), map.getZoom(), { animate: false, reset: true }); gm.triggerRepaint(); } };
      gm.once('load', kick); setTimeout(kick, 400); setTimeout(kick, 1500); setTimeout(kick, 4000);
    }).catch(e => { console.warn('vector map unavailable, falling back', e); setTile('gsi_pale'); });
    return;
  }
  const t = TILES[key];
  tileLayer = L.tileLayer(t.url, { attribution: t.attr, maxNativeZoom: t.maxNativeZoom, maxZoom: 20 }).addTo(map);
}
// 어댑터(ES 모듈)가 늦게 올라오므로 기다린다. WebGL 이 없거나 로드 실패면 reject → 래스터로 대체.
function ensureMaplibre() {
  if (window.__ofm) return Promise.resolve(window.__ofm);
  return new Promise((res, rej) => {
    window.addEventListener('ofm-ready', () => res(window.__ofm), { once: true });
    setTimeout(() => window.__ofm ? res(window.__ofm) : rej(new Error('maplibre load timeout')), 15000);
  });
}
// 지도 라벨 언어. 기본 스타일은 "Harima 播磨町" 처럼 로마자+현지어를 같이 써서 지저분하다.
//  ja    : 일본어만
//  ko    : 한국어가 있으면 한국어, 없으면 일본어 (OSM 에 name:ko 가 있는 곳은 역·큰 시설·지명 정도)
//  ko_ja : 한국어 + 일본어 두 줄 (현장 간판과 맞춰 보기 좋음)
//  latin_ja : 로마자 + 일본어 (한국어 이름이 없는 골목·丁目도 읽을 수 있게. 播磨町 실측: 이름 있는 330개 중 한국어는 3개뿐)
const JA = ['coalesce', ['get', 'name:ja'], ['get', 'name']];
const LATIN = ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];
const LABEL_EXPR = {
  ja: JA,
  ko: ['coalesce', ['get', 'name:ko'], JA],
  ko_ja: ['case', ['has', 'name:ko'], ['concat', ['get', 'name:ko'], '\n', JA], JA],
  latin_ja: ['case', ['has', 'name:ko'], ['concat', ['get', 'name:ko'], '\n', JA], ['has', 'name:nonlatin'], ['concat', LATIN, '\n', JA], JA],
};
let labelHandler = null;
function localizeLabels(gl) {
  const gm = gl.getMaplibreMap(); if (!gm) return;
  if (labelHandler) { try { gm.off('styledata', labelHandler); gm.off('load', labelHandler); } catch (e) { /* ignore */ } }
  const expr = LABEL_EXPR[S.labelLang] || LABEL_EXPR.ja;
  const key = JSON.stringify(expr);
  // isStyleLoaded() 는 타일까지 다 받아야 true 라서 쓰지 않는다. 스타일 JSON 만 들어오면 바로 바꾼다.
  const apply = () => {
    let st; try { st = gm.getStyle(); } catch (e) { return; }
    if (!st || !st.layers) return;
    addGsiBuildings(gm, st);
    for (const ly of st.layers) {
      if (ly.type !== 'symbol' || !ly.layout || !ly.layout['text-field']) continue;
      if (JSON.stringify(ly.layout['text-field']) === key) continue;   // 이미 바꾼 레이어는 건너뜀 (styledata 재귀 방지)
      try { gm.setLayoutProperty(ly.id, 'text-field', expr); } catch (e) { /* 아직 준비 안 됨 */ }
    }
  };
  labelHandler = apply;
  gm.on('styledata', apply); gm.on('load', apply); apply();
}
// 지리원 건물 레이어를 라벨 아래에 끼워 넣고, OSM 건물 레이어는 숨긴다 (겹쳐 그리면 지저분).
function addGsiBuildings(gm, st) {
  try {
    if (!gm.getSource('gsi_bvmap')) gm.addSource('gsi_bvmap', { type: 'vector', tiles: [GSI_BVMAP_TILES], minzoom: 14, maxzoom: 16, attribution: '地理院タイル' });
    for (const ly of st.layers) if (ly['source-layer'] === 'building' && ly.source !== 'gsi_bvmap' && (!ly.layout || ly.layout.visibility !== 'none')) gm.setLayoutProperty(ly.id, 'visibility', 'none');
    if (gm.getLayer('gsi_building')) return;
    const firstSymbol = (st.layers.find(l => l.type === 'symbol') || {}).id;
    const code = ['to-number', ['get', 'ftCode']];
    const isShed = ['any', ['==', code, 3111], ['==', code, 3112]];   // 無壁舎: 차고·지붕만
    const isRC = ['any', ['==', code, 3102], ['==', code, 3103]];     // 堅ろう·高層
    gm.addLayer({
      id: 'gsi_building', type: 'fill', source: 'gsi_bvmap', 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-color': ['case', isShed, '#ece7df', isRC, '#cbc2b6', '#dcd3c7'],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 16, 0.85],
        'fill-outline-color': ['case', isShed, '#d8d1c6', '#a89d8e'],
      },
    }, firstSymbol);
  } catch (e) { console.warn('gsi buildings', e); }
}
function setLabelLang(v) {
  S.labelLang = v; Store.set('labelLang', v);
  if (tileLayer && tileLayer.getMaplibreMap) localizeLabels(tileLayer);
}
function metersToPx(m) {
  const lat = map.getCenter().lat;
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, map.getZoom()));
  return m / mpp;
}
function updateHaloWeights() {
  const w = Math.max(4, metersToPx(S.coverRadius * 2));
  for (const id in trackLayers) trackLayers[id].halo.setStyle({ weight: w });
}

// ---------- 시작 ----------
function boot() {
  S.lang = Store.get('lang', navigator.language && navigator.language.startsWith('ja') ? 'ja' : 'ko');
  window.i18nLang = S.lang; applyI18n();
  S.tile = Store.get('tile', 'ofm_liberty');
  S.labelLang = Store.get('labelLang', S.lang === 'ko' ? 'latin_ja' : 'ja');
  S.syncKind = Store.get('syncKind', 'local');
  S.firebaseCfg = Store.get('firebaseCfg', null);
  S.sim = Store.get('sim', false);
  S.ovRadius = Store.get('ovRadius', 15);
  S.coverRadius = Store.get('coverRadius', 12);
  S.stride = Store.get('stride', 70);
  Object.assign(S.layers, Store.get('layers', {}));
  initMap();
  bindUI();
  // 초대 링크: ?code=1013-A 로 세션 코드를 미리 채우고, ?name= 까지 있으면 바로 입장. ?lat=&lng=&z= 로 지도 위치 공유.
  const q = new URLSearchParams(location.search);
  if (q.get('code')) Store.set('code', normCode(q.get('code')));
  S.me = Store.get('me', null);
  if (q.get('name')) { S.me = { id: (S.me && S.me.id) || Store.uid(), name: q.get('name').slice(0, 20), color: (S.me && S.me.color) || COLORS[Math.floor(Math.random() * COLORS.length)] }; Store.set('me', S.me); }
  if (S.me) S.me = withTabId(S.me);
  const code = Store.get('code', null);
  if (!S.me || !code) showWelcome(); else joinSession(code);
  if (q.get('lat') && q.get('lng')) map.setView([+q.get('lat'), +q.get('lng')], +(q.get('z') || 17));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

function showWelcome() {
  const def = S.me || { id: Store.uid(), name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  const d = new Date(); const defCode = (d.getMonth() + 1).toString().padStart(2, '0') + d.getDate().toString().padStart(2, '0') + '-A';
  openModal(`
    <h3>${t('welcome.title')}</h3>
    <p class="help">${t('welcome.help')}</p>
    <div class="field"><label>${t('set.name')}</label><input type="text" id="w-name" value="${esc(def.name)}" maxlength="20" autocomplete="off"></div>
    <div class="field"><label>${t('set.color')}</label><div class="colors" id="w-colors">${COLORS.map(c => `<span style="background:${c}" data-c="${c}" class="${c === def.color ? 'sel' : ''}"></span>`).join('')}</div></div>
    <div class="field"><label>${t('set.session')}</label><input type="text" id="w-code" value="${esc(Store.get('code', defCode))}" maxlength="24" autocomplete="off"><div class="help">${t('set.sessionHelp')}</div></div>
    <button class="btn primary block" id="w-go">${t('welcome.go')}</button>`);
  let color = def.color;
  $('#w-colors').addEventListener('click', e => { const s = e.target.closest('span[data-c]'); if (!s) return; color = s.dataset.c; $$('#w-colors span').forEach(x => x.classList.toggle('sel', x === s)); });
  $('#w-go').onclick = () => {
    const name = $('#w-name').value.trim() || '?'; const code = normCode($('#w-code').value);
    if (!code) return;
    Store.set('me', { id: def.id.split('.')[0], name, color }); S.me = withTabId({ id: def.id, name, color });
    closeModal(); joinSession(code);
  };
}
function normCode(s) { return (s || '').trim().replace(/\s+/g, '-').slice(0, 24); }
// '이 기기 안에서만' 모드는 같은 기기의 탭끼리 시연하는 용도라, 탭마다 다른 id 를 붙여 서로 다른 팀원으로 보이게 한다.
// (localStorage 는 탭이 공유하므로 그대로 쓰면 모든 탭이 '나'가 된다.) Firebase 모드는 기기당 하나의 id.
function withTabId(me) {
  if (S.syncKind !== 'local') return Object.assign({}, me, { id: me.id.split('.')[0] });
  let tok = null;
  try { tok = sessionStorage.getItem('fm.tab'); if (!tok) { tok = Math.random().toString(36).slice(2, 6); sessionStorage.setItem('fm.tab', tok); } } catch (e) { tok = 'x'; }
  return Object.assign({}, me, { id: me.id.split('.')[0] + '.' + tok });
}

// ---------- 세션 ----------
function joinSession(code) {
  leaveSession();
  S.code = code; Store.set('code', code);
  S.sess = Store.loadSession(code);
  S.members = {}; S.tracks = {}; S.coverage = S.sess.coverage || {}; S.passes = S.sess.passes || {}; S.lastHit = {}; S.grid.clear(); S.ovMeters = 0;
  if (S.sess.tracks && S.sess.tracks[S.me.id]) S.tracks[S.me.id] = S.sess.tracks[S.me.id];
  for (const z of S.sess.zones) if (z.est && !z.segs) queueEstimate(z, true);
  $('#session-badge').textContent = code; $('#me-badge').textContent = S.me.name;
  if (S.nav) stopNav();
  renderAll();
  connectSync();
  updateHud();
}
function leaveSession() {
  if (S.tracking) stopTracking();
  if (S.bots.length) removeBots();
  if (S.sync) { try { S.sync.send({ type: 'bye', memberId: S.me.id }); S.sync.close(); } catch (e) { /* ignore */ } S.sync = null; }
}
function connectSync() {
  try { S.sync = Sync.create(S.syncKind, S.code, S.me, S.firebaseCfg); }
  catch (e) { console.warn(e); S.sync = Sync.create('local', S.code, S.me); }
  S.sync.onMessage(onRemote);
  S.sync.send({ type: 'hello', me: S.me });
  sendPresence();
  toast(t('toast.synced', { code: S.code }));
}
function persist() {
  S.sess.coverage = S.coverage; S.sess.passes = S.passes;
  S.sess.tracks = { [S.me.id]: S.tracks[S.me.id] || [] };
  Store.saveSession(S.sess);
}

// ---------- 원격 메시지 ----------
function onRemote(msg) {
  switch (msg.type) {
    case 'hello':
      S.sync.send({ type: 'state', from: S.me.id, zones: S.sess.zones.map(Sync.stripZone), markers: S.sess.markers, tracks: { [S.me.id]: S.tracks[S.me.id] || [] }, coverage: S.coverage, passes: S.passes });
      sendPresence();
      break;
    case 'state':
      mergeZones(msg.zones || []); mergeMarkers(msg.markers || []);
      for (const id in (msg.tracks || {})) if (id !== S.me.id) replaceTrack(id, msg.tracks[id]);
      mergeCoverage(msg.coverage || {}); mergePasses(msg.passes || {});
      break;
    case 'passes': mergePasses(msg.items || {}); break;
    case 'presence':
      if (!msg.member || msg.member.id === S.me.id) break;
      S.members[msg.member.id] = Object.assign({}, S.members[msg.member.id], msg.member, { seen: Date.now() });
      renderMember(msg.member.id); renderTeam();
      break;
    case 'track':
      if (msg.memberId === S.me.id) break;
      appendTrack(msg.memberId, msg.points || []);
      break;
    case 'zones': mergeZones(msg.zones || []); break;
    case 'markers': mergeMarkers(msg.markers || []); break;
    case 'coverage': mergeCoverage(msg.items || {}); break;
    case 'bye':
      if (S.members[msg.memberId]) { S.members[msg.memberId].tracking = false; S.members[msg.memberId].seen = 0; renderMember(msg.memberId); renderTeam(); }
      break;
  }
}
function mergeZones(zones) {
  let changed = false;
  for (const z of zones) {
    const mine = S.sess.zones.find(x => x.id === z.id);
    if (!mine) { S.sess.zones.push(z); changed = true; if (z.est && !z.segs) queueEstimate(z, true); }
    else if ((z.updated || 0) > (mine.updated || 0)) { const segs = mine.segs, blds = mine.blds; Object.assign(mine, z); if (!mine.segs) mine.segs = segs; if (!mine.blds) mine.blds = blds; changed = true; if (mine.est && !mine.segs) queueEstimate(mine, true); }
    if (z.deleted && mine && !mine.deleted) { mine.deleted = true; changed = true; }
  }
  if (changed) { persist(); renderZones(); renderStreets(); renderRoutes(); }
}
function mergeMarkers(markers) {
  let changed = false;
  for (const m of markers) {
    const mine = S.sess.markers.find(x => x.id === m.id);
    if (!mine) { S.sess.markers.push(m); changed = true; }
    else if ((m.updated || 0) > (mine.updated || 0)) { Object.assign(mine, m); changed = true; }
  }
  if (changed) { persist(); renderPois(); }
}
function mergeCoverage(items) {
  let changed = false;
  for (const k in items) { if (items[k] && !S.coverage[k]) { S.coverage[k] = items[k]; changed = true; } if (items[k] === null && S.coverage[k]) { delete S.coverage[k]; changed = true; } }
  if (changed) { persist(); renderStreets(); renderZones(); }
}
// 통과 기록 병합: 같은 선분·같은 사람의 45초 이내 시각은 같은 통과로 본다.
function addPass(key, memberId, t) {
  const pm = (S.passes[key] = S.passes[key] || {}); const arr = (pm[memberId] = pm[memberId] || []);
  if (arr.some(x => Math.abs(x - t) < 45000)) return false;
  arr.push(t); arr.sort((a, b) => a - b); return true;
}
function mergePasses(items) {
  let changed = false;
  for (const k in items) { const key = k; for (const m in items[k]) for (const t of (items[k][m] || [])) if (addPass(key, m, t)) changed = true; }
  if (changed) { persist(); renderStreets(); renderTeam(); }
}
function replaceTrack(id, pts) {
  S.tracks[id] = pts.slice();
  rebuildGrid();
  drawTrack(id, true);
  for (const p of pts) checkCoverage(p, id, false);
  renderStreets(); renderZones(); renderTeam();
}
function appendTrack(id, pts) {
  if (!S.tracks[id]) S.tracks[id] = [];
  const arr = S.tracks[id]; const lastT = arr.length ? arr[arr.length - 1].t : 0;
  const fresh = pts.filter(p => p.t > lastT);
  if (!fresh.length) return;
  for (const p of fresh) { arr.push(p); S.grid.add(p, { id, p }); checkCoverage(p, id, false); }
  drawTrack(id, false, fresh);
  renderStreets(); renderZones(); renderTeam();
}
function rebuildGrid() {
  S.grid.clear();
  for (const id in S.tracks) if (id !== S.me.id) for (const p of S.tracks[id]) S.grid.add(p, { id, p });
}

// ---------- 위치 기록 ----------
function startTracking() {
  if (!S.sim && !navigator.geolocation) { toast(t('toast.noGeo'), 'err'); return; }
  S.tracking = true; S.lastPt = null;
  if (!S.sim) {
    setGps('wait');
    S.watchId = navigator.geolocation.watchPosition(onPosition, onPosError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  } else setGps('sim');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => S.wakeLock = w).catch(() => {});
  $('#fab-track').classList.add('on'); $('#fab-track .fab-ico').textContent = '■'; $('#fab-track .fab-lbl').textContent = t('track.stop');
  toast(t('toast.trackOn')); sendPresence(); renderTeam();
}
function stopTracking() {
  S.tracking = false;
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
  flushPending();
  setGps('off');
  $('#fab-track').classList.remove('on'); $('#fab-track .fab-ico').textContent = '▶'; $('#fab-track .fab-lbl').textContent = t('track.start');
  toast(t('toast.trackOff')); sendPresence(); renderTeam();
}
function onPosition(pos) {
  const c = pos.coords;
  acceptPoint({ lat: c.latitude, lng: c.longitude, acc: Math.round(c.accuracy || 0), t: Date.now() });
}
function onPosError(err) {
  setGps('err');
  if (err.code === 1) { toast(t('toast.geoDenied'), 'err'); stopTracking(); }
}
// GPS 점 필터: 정확도 나쁜 점, 비현실적 점프, 3m 미만 이동은 궤적에 넣지 않는다.
function acceptPoint(pt) {
  S.myPos = pt; updateMyMarker(pt);
  if (S.follow) map.panTo([pt.lat, pt.lng], { animate: true, duration: 0.5 });
  if (pt.acc && pt.acc > 60) { setGps('bad'); return; }
  setGps(S.sim ? 'sim' : 'good');
  const last = S.lastPt;
  if (last) {
    const d = Geo.dist(last, pt), dt = (pt.t - last.t) / 1000;
    if (dt > 0 && d / dt > 8) return;   // 8 m/s 초과 = 튄 점
    if (d < 3) return;
  }
  S.lastPt = pt;
  if (!S.tracks[S.me.id]) S.tracks[S.me.id] = [];
  const ov = checkOverlap(pt);
  if (ov) pt.ov = ov;
  S.tracks[S.me.id].push(pt);
  const cov = checkCoverage(pt, S.me.id, true);
  drawTrack(S.me.id, false, [pt]);
  if (cov) { renderStreets(); renderZones(); }
  updateNav(pt);
  S.pending.push(pt);
  if (!S.flushTimer) S.flushTimer = setTimeout(flushPending, FLUSH_MS);
  sendPresence(); persist(); updateHud(); renderTeam();
}
function flushPending() {
  clearTimeout(S.flushTimer); S.flushTimer = null;
  if (S.pending.length && S.sync) S.sync.send({ type: 'track', memberId: S.me.id, points: S.pending.splice(0) });
}
function sendPresence() {
  if (!S.sync) return;
  const p = S.myPos || {};
  S.sync.send({ type: 'presence', member: { id: S.me.id, name: S.me.name, color: S.me.color, lat: p.lat || null, lng: p.lng || null, acc: p.acc || null, t: Date.now(), tracking: S.tracking } });
}
setInterval(() => { if (S.sync) sendPresence(); renderTeam(); }, 15000);

// 다른 팀원이 이미 지나간 자리인지. 45초 이상 차이가 날 때만 (나란히 걷는 경우 제외).
function checkOverlap(pt) {
  const near = S.grid.near(pt);
  let hit = null;
  for (const n of near) {
    if (Math.abs(n.p.t - pt.t) < 45000) continue;
    if (Geo.dist(n.p, pt) <= S.ovRadius) { hit = n.id; break; }
  }
  if (hit) {
    const prev = S.tracks[S.me.id][S.tracks[S.me.id].length - 1];
    if (prev) S.ovMeters += Geo.dist(prev, pt);
    if (Date.now() - S.lastOvToast > 20000) {
      S.lastOvToast = Date.now();
      const nm = (S.members[hit] || {}).name || '?';
      toast(t('toast.overlap', { name: nm }), 'warn');
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
  }
  return hit;
}
// 구역 안의 길 선분 중 반경 내에 있는 것을 '완료' 처리(처음 지나간 사람에게 귀속)하고, 통과 시각을 쌓는다.
// 같은 선분을 45초 넘게 떠났다가 다시 오면 새 통과 = 왕복이 그대로 남는다.
function checkCoverage(pt, memberId, broadcast) {
  const changed = {}, passed = {}; let any = false;
  const dLat = Geo.mToLat(S.coverRadius + 5), dLng = Geo.mToLng(S.coverRadius + 5, pt.lat);
  for (const z of S.sess.zones) {
    if (z.deleted || !z.segs) continue;
    const bb = z.bb || (z.bb = Geo.bbox(z.latlngs));
    if (pt.lat < bb.s - dLat || pt.lat > bb.n + dLat || pt.lng < bb.w - dLng || pt.lng > bb.e + dLng) continue;
    for (const s of z.segs) {
      if (Math.abs(s.a[0] - pt.lat) > dLat * 3 && Math.abs(s.b[0] - pt.lat) > dLat * 3) continue;
      if (Geo.pointToSegment(pt, s.a, s.b) > S.coverRadius) continue;
      if (!S.coverage[s.key]) { S.coverage[s.key] = memberId; changed[s.key] = memberId; any = true; }
      const hk = s.key + '|' + memberId, last = S.lastHit[hk];
      S.lastHit[hk] = pt.t;
      if (last == null || pt.t - last > 45000) { if (addPass(s.key, memberId, pt.t)) { passed[s.key] = { [memberId]: S.passes[s.key][memberId] }; any = true; } }
    }
  }
  if (broadcast && S.sync) {
    if (Object.keys(changed).length) S.sync.send({ type: 'coverage', items: changed });
    if (Object.keys(passed).length) S.sync.send({ type: 'passes', items: passed });
  }
  if (any) persist();
  return any;
}
// 사람별 통계: 거리, 걸음(보폭 설정), 전단지 추정(내가 처음 지나간 골목에 면한 집·세대 수)
function memberStats(id) {
  const dist = Geo.pathLength(S.tracks[id] || []);
  const steps = Math.round(dist / (S.stride / 100));
  let flyers = 0, houses = 0;
  for (const z of S.sess.zones) if (!z.deleted && z.blds) for (const b of z.blds) if (b.seg && S.coverage[b.seg] === id) { houses++; flyers += b.hh; }
  return { dist, steps, flyers, houses };
}

// ---------- 그리기: 궤적 / 팀원 ----------
function memberColor(id) { if (id === S.me.id) return S.me.color; return (S.members[id] || {}).color || '#777'; }
function memberName(id) { if (id === S.me.id) return S.me.name; return (S.members[id] || {}).name || '?'; }
// 구역 담당자 이름: 담당자가 지금 접속해 있지 않아도 보이도록 구역에 이름을 같이 저장해 둔다.
function zoneWho(z) { if (!z.memberId) return t('zone.unassigned'); const n = memberName(z.memberId); return n !== '?' ? n : (z.memberName || '?'); }
function trackVisible(id) { return id === S.me.id ? S.layers.myTrack : S.layers.otherTracks; }
function drawTrack(id, rebuild, fresh) {
  const pts = S.tracks[id] || [];
  let tl = trackLayers[id];
  const color = memberColor(id);
  const vis = trackVisible(id);
  if (!tl || rebuild) {
    if (tl) { LG.tracks.removeLayer(tl.halo); LG.tracks.removeLayer(tl.core); tl.ov.forEach(l => LG.tracks.removeLayer(l)); }
    const ll = pts.map(p => [p.lat, p.lng]);
    tl = trackLayers[id] = {
      halo: L.polyline(ll, { color, weight: Math.max(4, metersToPx(S.coverRadius * 2)), opacity: vis ? 0.16 : 0, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(LG.tracks),
      core: L.polyline(ll, { color, weight: 3, opacity: vis ? 0.9 : 0, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(LG.tracks),
      ov: [], lastOv: null, id,
    };
    for (let i = 1; i < pts.length; i++) if (pts[i].ov) addOvSeg(tl, pts[i - 1], pts[i]);
  } else {
    for (const p of fresh) {
      const prev = pts[pts.indexOf(p) - 1];
      tl.halo.addLatLng([p.lat, p.lng]); tl.core.addLatLng([p.lat, p.lng]);
      if (p.ov && prev) addOvSeg(tl, prev, p);
    }
  }
}
function addOvSeg(tl, a, b) {
  tl.ov.push(L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#d33a2c', weight: 5, opacity: trackVisible(tl.id) ? 0.85 : 0, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(LG.tracks));
}
// ---------- 표시 켜기/끄기 · 따라가기 ----------
function applyLayers() {
  const on = (g, v) => { if (v) { if (!map.hasLayer(g)) g.addTo(map); } else if (map.hasLayer(g)) map.removeLayer(g); };
  on(LG.route, S.layers.route); on(LG.streets, S.layers.streets); on(LG.bld, S.layers.blds); on(LG.pois, S.layers.pois); on(LG.zones, S.layers.zones);
  for (const id in memberMarkers) { const mk = memberMarkers[id]; if (S.layers.members) { if (!LG.members.hasLayer(mk)) mk.addTo(LG.members); } else LG.members.removeLayer(mk); }
  for (const id in trackLayers) drawTrack(id, true);
  renderRoutes();
  $$('#layers-pop input[data-layer]').forEach(cb => cb.checked = !!S.layers[cb.dataset.layer]);
  $('#nav-toggle-route').textContent = S.layers.route ? t('layer.routeToggle') : t('layer.routeShow');
}
function setLayer(k, v) { S.layers[k] = v; Store.set('layers', S.layers); applyLayers(); }
function toggleLayersPop() {
  const p = $('#layers-pop'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { const r = $('#fab-layers').getBoundingClientRect(); p.style.top = Math.max(60, Math.min(r.top - 10, window.innerHeight - 340)) + 'px'; }
}
function setFollow(v) { S.follow = v; $('#fab-locate').classList.toggle('follow', v); }
function memberIcon(id, me, stale) {
  const nm = me ? t('team.me') : memberName(id);
  return L.divIcon({ className: '', iconSize: [1, 1], iconAnchor: [0, 0], html: `<div class="member-icon ${me ? 'me' : ''} ${stale ? 'stale' : ''}" style="transform:translate(-50%,-9px)"><div class="pin" style="background:${memberColor(id)}"></div><div class="lbl">${esc(nm)}</div></div>` });
}
function updateMyMarker(pt) {
  if (!myMarker) myMarker = L.marker([pt.lat, pt.lng], { icon: memberIcon(S.me.id, true), zIndexOffset: 1000, interactive: false }).addTo(LG.members);
  else myMarker.setLatLng([pt.lat, pt.lng]);
}
function renderMember(id) {
  const m = S.members[id]; if (!m || m.lat == null) return;
  const stale = Date.now() - (m.seen || 0) > STALE_MS;
  if (!memberMarkers[id]) { memberMarkers[id] = L.marker([m.lat, m.lng], { icon: memberIcon(id, false, stale), interactive: false }); if (S.layers.members) memberMarkers[id].addTo(LG.members); }
  else { memberMarkers[id].setLatLng([m.lat, m.lng]); memberMarkers[id].setIcon(memberIcon(id, false, stale)); }
}

// ---------- 구역 ----------
function startDraw() {
  cancelPoi();
  S.draw = { pts: [], line: L.polyline([], { color: '#1f6f8b', weight: 2, dashArray: '4 6' }).addTo(LG.draw), vs: [] };
  $('#draw-bar').classList.remove('hidden'); $('#fab-zone').classList.add('active'); collapseSheet();
}
function drawAdd(ll) {
  S.draw.pts.push([ll.lat, ll.lng]);
  S.draw.line.setLatLngs(S.draw.pts.concat(S.draw.pts.length > 2 ? [S.draw.pts[0]] : []));
  S.draw.vs.push(L.marker(ll, { icon: L.divIcon({ className: 'vertex-icon', iconSize: [12, 12] }), interactive: false }).addTo(LG.draw));
}
function drawUndo() { if (!S.draw || !S.draw.pts.length) return; S.draw.pts.pop(); LG.draw.removeLayer(S.draw.vs.pop()); S.draw.line.setLatLngs(S.draw.pts.concat(S.draw.pts.length > 2 ? [S.draw.pts[0]] : [])); }
function cancelDraw() { if (!S.draw) return; LG.draw.clearLayers(); S.draw = null; $('#draw-bar').classList.add('hidden'); $('#fab-zone').classList.remove('active'); }
function finishDraw() {
  if (!S.draw || S.draw.pts.length < 3) { toast(t('toast.needPts'), 'warn'); return; }
  const n = S.sess.zones.filter(z => !z.deleted).length + 1;
  const z = { id: Store.uid(), name: (S.lang === 'ja' ? 'エリア ' : '구역 ') + n, memberId: S.me.id, memberName: S.me.name, latlngs: S.draw.pts.slice(), hhManual: null, est: null, updated: Date.now() };
  S.sess.zones.push(z); cancelDraw(); persist(); renderZones(); broadcastZones();
  toast(t('toast.zoneCreated')); openZoneEditor(z.id); queueEstimate(z, false);
}
function broadcastZones() { if (S.sync) S.sync.send({ type: 'zones', zones: S.sess.zones.map(Sync.stripZone) }); }
function zoneStats(z) {
  const segs = z.segs || []; let total = 0, done = 0;
  for (const s of segs) { total += s.len; if (S.coverage[s.key]) done += s.len; }
  const hh = z.hhManual != null && z.hhManual !== '' ? Number(z.hhManual) : (z.est ? z.est.hh : null);
  return { total: Math.round(total), done: Math.round(done), pct: total ? Math.round(done / total * 100) : 0, hh, minutes: z.est ? z.est.minutes : null };
}
function renderZones() {
  if (!S.sess) return;
  LG.zones.clearLayers();
  for (const z of S.sess.zones) {
    if (z.deleted) continue;
    const color = z.memberId ? memberColor(z.memberId) : '#64748b';
    const st = zoneStats(z);
    const poly = L.polygon(z.latlngs, { color, weight: 2, fillColor: color, fillOpacity: 0.08, dashArray: z.memberId ? null : '6 6' }).addTo(LG.zones);
    poly.on('click', e => { if (S.draw || S.poiMode || S.sim && S.tracking) return; L.DomEvent.stopPropagation(e); openZoneEditor(z.id); });
    poly.bindTooltip(`${esc(z.name)} · ${esc(zoneWho(z))}${st.total ? ' · ' + st.pct + '%' : ''}`, { permanent: true, direction: 'center', className: 'zone-label' });
  }
  renderZoneList();
}
// 집 한 동 = 점 하나. 회색 = 아직, 색 = 그 골목을 처음 지나간 사람 색. アパート 의심은 주황 테두리 (탭하면 ✅ 기록).
const bldLayers = {};
function renderBuildings() {
  const live = new Set();
  for (const z of S.sess.zones) {
    if (z.deleted || !z.blds) continue;
    z.blds.forEach((b, i) => {
      const k = z.id + ':' + i; live.add(k);
      const by = b.seg ? S.coverage[b.seg] : null;
      const style = { radius: b.sus ? 6 : 3.5, color: b.sus ? '#d98a00' : (by ? memberColor(by) : '#8b8f96'), weight: b.sus ? 2 : 1, fillColor: by ? memberColor(by) : (b.sus ? '#fff' : '#c9ccd1'), fillOpacity: 0.9 };
      let mk = bldLayers[k];
      if (!mk) {
        mk = bldLayers[k] = L.circleMarker([b.lat, b.lng], Object.assign({ bubblingMouseEvents: false, interactive: !!b.sus }, style)).addTo(LG.bld);
        if (b.sus) {
          mk.bindTooltip(t('bld.sus', { n: b.hh }), { direction: 'top', offset: [0, -6] });
          mk.on('click', e => { if (S.draw || S.poiMode || (S.sim && S.tracking)) return; L.DomEvent.stopPropagation(e); S.poiMode = 'done'; placePoi({ lat: b.lat, lng: b.lng }); });
        }
      } else mk.setStyle(style);
    });
  }
  for (const k in bldLayers) if (!live.has(k)) { LG.bld.removeLayer(bldLayers[k]); delete bldLayers[k]; }
}
// 길 선분 말풍선: 이름 · 면한 집 수 · 누가 몇 번 지나갔는지(시각)
function segTooltip(s) {
  const pm = S.passes[s.key] || {};
  const who = Object.keys(pm).map(id => `${esc(memberName(id))} ${pm[id].length}${t('street.times')} (${pm[id].map(fmtTime).join(', ')})`).join('<br>');
  return `<b>${esc(s.name || t('street.noname'))}</b> · ${t('street.houses')} ${s.houses || 0}${s.hh && s.hh !== s.houses ? ` (${s.hh}${t('zone.est.hhUnit')})` : ''}<br>${who || t('street.nopass')}`;
}
function renderStreets() {
  if (!S.sess) return;
  for (const z of S.sess.zones) {
    if (z.deleted || !z.segs) continue;
    for (const s of z.segs) {
      const by = S.coverage[s.key];
      const n = Object.values(S.passes[s.key] || {}).reduce((a, arr) => a + arr.length, 0);
      const style = by ? { color: memberColor(by), weight: Math.min(7, 3 + n), opacity: 0.75, dashArray: null } : { color: '#9ca3af', weight: 2.5, opacity: 0.6, dashArray: '1 6' };
      let l = segLayers[s.key];
      if (!l) {
        l = segLayers[s.key] = L.polyline([s.a, s.b], Object.assign({ lineCap: 'round', bubblingMouseEvents: false }, style)).addTo(LG.streets);
        l.bindTooltip(() => segTooltip(s), { sticky: true, direction: 'top' });
        l.on('click', e => { if (S.draw || S.poiMode || (S.sim && S.tracking)) return; L.DomEvent.stopPropagation(e); toggleSeg(s.key); });
      } else l.setStyle(style);
    }
  }
  // 삭제된 구역의 선분 정리
  for (const k in segLayers) { const zid = k.split(':')[0]; const z = S.sess.zones.find(x => x.id === zid); if (!z || z.deleted) { LG.streets.removeLayer(segLayers[k]); delete segLayers[k]; } }
  renderBuildings(); updateHud();
}
function toggleSeg(key) {
  const items = {};
  if (S.coverage[key]) { delete S.coverage[key]; items[key] = null; } else { S.coverage[key] = S.me.id; items[key] = S.me.id; }
  if (S.sync) S.sync.send({ type: 'coverage', items });
  persist(); renderStreets(); renderZones(); toast(t('toast.streetToggle'));
}
function queueEstimate(z, silent) {
  if (S.estQueue.includes(z)) return;
  S.estQueue.push(z); runEstimateQueue(silent);
}
async function runEstimateQueue(silent) {
  if (S.estBusy) return; S.estBusy = true;
  while (S.estQueue.length) {
    const z = S.estQueue.shift();
    try {
      const r = await Estimate.estimateZone(z);
      z.segs = r.segs; z.blds = r.blds; const est = Object.assign({}, r); delete est.segs; delete est.blds;
      if (!z.est || !silent) { z.est = est; z.updated = Date.now(); broadcastZones(); }
      else z.est = z.est || est;
      // 이미 쌓인 궤적으로 완료 처리
      for (const id in S.tracks) for (const p of S.tracks[id]) checkCoverage(p, id, false);
      persist(); renderStreets(); renderZones();
      if ($('#ze-est') && $('#ze-est').dataset.zone === z.id) $('#ze-est').innerHTML = estHtml(z);
    } catch (e) { console.warn('estimate failed', e); if (!silent) toast(t('zone.est.fail'), 'err'); if ($('#ze-est') && $('#ze-est').dataset.zone === z.id) $('#ze-est').innerHTML = `<div class="est">${t('zone.est.fail')}</div>`; }
    await new Promise(r => setTimeout(r, 1500)); // Overpass 공용 서버 배려
  }
  S.estBusy = false;
}
function estHtml(z) {
  const e = z.est; if (!e) return `<div class="est">${t('zone.estimating')}</div>`;
  const m = t('zone.est.m'), u = t('zone.est.hhUnit');
  let body = '';
  if (e.buildings > 0) {
    if (e.src === 'gsi') {
      const pct = e.gsiBuildings ? Math.round(e.osmBuildings / e.gsiBuildings * 100) : null;
      body += `${t('zone.est.gsi')} ${e.gsiBuildings}棟${pct != null ? ` <span class="note">(${t('zone.est.osmCover', { pct })})</span>` : ''}<br>`;
    } else body += `<span class="note">${t('zone.est.gsiFail')}</span><br>`;
    const sus = (e.suspects || []).length;
    body += `${t('zone.est.houses')} ${e.houses} · ${t('zone.est.apts')} ${e.apts}棟 (${t('zone.est.units')} ${e.aptUnits}${u})`;
    if (sus) body += ` · <span style="color:var(--warn)">${t('zone.est.aptSus')} ${sus}棟</span>`;
    body += '<br>';
    body += `<b>${t('zone.est.total')} ${e.hhByBuilding}${u}</b> <span class="note">(${t('zone.est.byStreet')} ${e.hhByStreet}${u})</span><br>`;
  } else {
    body += `<span class="note">${t('zone.est.noBuildings')}</span><br><b>${t('zone.est.byStreet')} ${e.hhByStreet}${u}</b><br>`;
  }
  if (!e.streetLen) body += `<span class="note">${t('zone.est.noStreets')}</span><br>`;
  body += `${t('zone.est.streets')} ${e.streetLen}${m} · ${t('zone.est.time')} ≈ <b>${e.minutes}${t('zone.est.min')}</b>`;
  return `<div class="est"><div class="note">${t('zone.est.title')}</div>${body}</div>`;
}
function openZoneEditor(id) {
  const z = S.sess.zones.find(x => x.id === id); if (!z) return;
  const ids = [S.me.id, ...Object.keys(S.members)];
  if (z.memberId && !ids.includes(z.memberId)) ids.push(z.memberId);   // 지금 접속해 있지 않은 담당자도 유지
  const opts = [`<option value="">${t('zone.unassigned')}</option>`].concat(ids.map(m => `<option value="${m}" ${z.memberId === m ? 'selected' : ''}>${esc(m === z.memberId ? zoneWho(z) : memberName(m))}</option>`)).join('');
  openModal(`
    <h3>${esc(z.name)}</h3>
    <div class="field"><label>${t('zone.name')}</label><input type="text" id="ze-name" value="${esc(z.name)}" maxlength="30"></div>
    <div class="field"><label>${t('zone.assignee')}</label><select id="ze-who">${opts}</select></div>
    <div class="field"><label>${t('zone.hhManual')}</label><input type="number" id="ze-hh" min="0" value="${z.hhManual != null ? z.hhManual : ''}" placeholder="${z.est ? z.est.hh : ''}"></div>
    <div id="ze-est" data-zone="${z.id}">${z.est ? estHtml(z) : `<div class="est">${t('zone.estimating')}</div>`}</div>
    <div class="btn-row"><button class="btn small" id="ze-est-btn">${t('zone.estimate')}</button><button class="btn small" id="ze-center">◎</button></div>
    <div class="section-title">${t('route.section')}</div>
    <div class="btn-row">
      <button class="btn small" id="ze-pin-start">📍 ${t('pin.start')}: ${z.start ? t('pin.set') : t('pin.unset')}</button>
      <button class="btn small" id="ze-pin-meet">🏁 ${t('pin.meet')}: ${z.meet ? t('pin.set') : t('pin.unset')}</button>
      ${z.meet ? `<button class="btn small" id="ze-pin-meet-clear">✕</button>` : ''}
    </div>
    <div class="field inline"><label>${t('route.people')}</label><input type="number" id="ze-people" min="1" max="12" value="${z.people || 1}" style="width:70px"></div>
    <div class="btn-row"><button class="btn small primary" id="ze-routes" ${z.segs && z.segs.length ? '' : 'disabled'}>${t('route.makeK')}</button><button class="btn small" id="ze-route-here" ${z.segs && z.segs.length && S.myPos ? '' : 'disabled'}>${t('route.fromHere')}</button></div>
    <div id="ze-route-list">${routeListHtml(z)}</div>
    <div class="btn-row">${zoneRoutes(z).length ? `<button class="btn small" id="ze-sim">▶ ${t('sim.view')}</button><button class="btn small" id="ze-nav">${t('route.nav')}</button><button class="btn small" id="ze-route-del">${t('route.delete')}</button>` : ''}</div>
    <div class="btn-row" style="justify-content:space-between;margin-top:12px"><button class="btn danger" id="ze-del">${t('zone.delete')}</button><button class="btn primary" id="ze-save">${t('zone.save')}</button></div>`);
  $('#ze-est-btn').onclick = () => { $('#ze-est').innerHTML = `<div class="est">${t('zone.estimating')}</div>`; z.segs = null; queueEstimate(z, false); };
  $('#ze-center').onclick = () => { map.fitBounds(L.latLngBounds(z.latlngs), { padding: [30, 30] }); closeModal(); };
  $('#ze-pin-start').onclick = () => { closeModal(); startPinMode(z.id, 'start'); };
  $('#ze-pin-meet').onclick = () => { closeModal(); startPinMode(z.id, 'meet'); };
  if ($('#ze-pin-meet-clear')) $('#ze-pin-meet-clear').onclick = () => { delete z.meet; z.updated = Date.now(); persist(); renderRoutes(); broadcastZones(); openZoneEditor(z.id); };
  $('#ze-people').onchange = e => { z.people = Math.max(1, Math.min(12, +e.target.value || 1)); z.updated = Date.now(); persist(); };
  $('#ze-routes').onclick = () => { z.people = Math.max(1, Math.min(12, +$('#ze-people').value || 1)); if (!z.start) { closeModal(); toast(t('route.needStart'), 'warn'); startPinMode(z.id, 'start'); return; } computeRoutes(z.id); };
  $('#ze-route-here').onclick = () => { closeModal(); if (S.myPos) { computeRoute(z.id, [S.myPos.lat, S.myPos.lng]); setFollow(true); } };
  $$('#ze-route-list select[data-ri]').forEach(sel => sel.onchange = () => { const rt = zoneRoutes(z)[+sel.dataset.ri]; rt.memberId = sel.value || null; rt.memberName = rt.memberId ? memberName(rt.memberId) : null; z.updated = Date.now(); persist(); renderRoutes(); broadcastZones(); });
  if ($('#ze-sim')) $('#ze-sim').onclick = () => { closeModal(); simStart(z.id); };
  if ($('#ze-nav')) $('#ze-nav').onclick = () => { closeModal(); startNav(z.id); };
  if ($('#ze-route-del')) $('#ze-route-del').onclick = () => { delete z.route; delete z.routes; z.updated = Date.now(); if (S.nav && S.nav.zoneId === z.id) stopNav(); if (SIM.zoneId === z.id) simStop(); persist(); renderRoutes(); broadcastZones(); closeModal(); };
  $('#ze-del').onclick = () => { if (!confirm(t('zone.confirmDelete'))) return; z.deleted = true; z.updated = Date.now(); persist(); renderZones(); renderStreets(); broadcastZones(); closeModal(); };
  $('#ze-save').onclick = () => {
    z.name = $('#ze-name').value.trim() || z.name; z.memberId = $('#ze-who').value || null; z.memberName = z.memberId ? memberName(z.memberId) : null;
    const hh = $('#ze-hh').value; z.hhManual = hh === '' ? null : Number(hh); z.updated = Date.now();
    persist(); renderZones(); broadcastZones(); closeModal(); toast(t('toast.saved'));
  };
}
function renderZoneList() {
  const el = $('#tab-zones'); const zs = S.sess.zones.filter(z => !z.deleted);
  let h = `<p class="help">${t('zones.help')}</p>`;
  if (!zs.length) h += `<div class="empty">${t('zones.empty')}</div>`;
  for (const z of zs) {
    const st = zoneStats(z); const color = z.memberId ? memberColor(z.memberId) : '#64748b';
    h += `<div class="row clickable" data-zone="${z.id}"><span class="swatch" style="background:${color}"></span><div class="grow"><div class="name">${esc(z.name)} <span class="pill">${esc(zoneWho(z))}</span></div>
      <div class="meta">${st.hh != null ? st.hh + t('zone.est.hhUnit') : '—'} · ${t('zone.streets')} ${st.done}/${st.total}m${st.minutes != null ? ' · ' + t('zone.time') + ' ' + st.minutes + t('zone.est.min') : ''}${zoneRoutes(z).length ? ' · 🧭 ' + zoneRoutes(z).length + '×' + fmtDist(Math.max(...zoneRoutes(z).map(r => r.len))) : ''}</div>
      <div class="bar"><i style="width:${st.pct}%;background:${color}"></i></div></div><div class="pill ${st.pct >= 100 ? 'on' : ''}">${st.pct}%</div></div>`;
  }
  h += `<button class="btn primary block" id="zl-new">+ ${t('zones.new')}</button>`;
  el.innerHTML = h;
  $('#zl-new').onclick = startDraw;
  $$('#tab-zones [data-zone]').forEach(r => r.onclick = () => openZoneEditor(r.dataset.zone));
}

// ---------- 경로 (우편배달부) ----------
const ROUTE_COLORS = ['#111827', '#be123c', '#1d4ed8', '#047857', '#b45309', '#6d28d9', '#0e7490', '#9f1239', '#4d7c0f', '#7c2d12', '#1e3a8a', '#701a75'];
function zoneRoutes(z) { return z.routes && z.routes.length ? z.routes : (z.route ? [Object.assign({ idx: 0 }, z.route)] : []); }
function myRoute(z) { const rs = zoneRoutes(z); return rs.find(r => r.memberId === S.me.id) || (rs.length === 1 ? rs[0] : null); }
function startRouteMode(zid) { cancelDraw(); cancelPoi(); cancelPinMode(); S.routeMode = zid; $('#route-bar').classList.remove('hidden'); $('#route-bar span').textContent = t('route.tapStart'); collapseSheet(); }
function cancelRouteMode() { S.routeMode = null; if (!S.pinMode) $('#route-bar').classList.add('hidden'); }
// 핀 찍기: 출발점 / 집결지. 찍은 뒤에는 드래그로 조정.
function startPinMode(zid, kind) { cancelDraw(); cancelPoi(); cancelRouteMode(); S.pinMode = { zoneId: zid, kind }; $('#route-bar').classList.remove('hidden'); $('#route-bar span').textContent = t(kind === 'start' ? 'pin.tapStart' : 'pin.tapMeet'); collapseSheet(); }
function cancelPinMode() { S.pinMode = null; if (!S.routeMode) $('#route-bar').classList.add('hidden'); }
function setPin(zid, kind, ll, silent) {
  const z = S.sess.zones.find(x => x.id === zid); if (!z) return;
  z[kind] = [+ll[0].toFixed(6), +ll[1].toFixed(6)]; z.updated = Date.now();
  persist(); renderRoutes(); broadcastZones();
  if (zoneRoutes(z).length && z.start) computeRoutes(z.id, true);   // 핀을 옮기면 경로도 다시
  if (!silent) { toast(t('pin.placed')); openZoneEditor(z.id); }
}
// 구역의 출발점·집결지·인원 수로 경로 k 개 생성
function computeRoutes(zid, quiet) {
  const z = S.sess.zones.find(x => x.id === zid); if (!z || !z.segs || !z.segs.length || !z.start) return;
  const req = new Set(z.segs.filter(s => !S.coverage[s.key]).map(s => s.key));
  if (!req.size) { toast(t('route.allDone'), 'warn'); return; }
  const k = Math.max(1, z.people || 1);
  const t0 = performance.now();
  let r; try { r = Route.plan(z.segs, z.start, req, z.meet || null, k); } catch (e) { console.warn('route', e); r = null; }
  if (!r) { toast(t('route.fail'), 'err'); return; }
  const prev = zoneRoutes(z);
  const list = k === 1 ? [Object.assign({ idx: 0 }, r)] : r.routes;
  // 담당 배정: 이전 배정 유지, 없으면 1번은 구역 담당자(또는 나)
  const members = [S.me.id, ...Object.keys(S.members).filter(id => !S.members[id].bot)];
  const used = new Set();
  z.routes = list.map((rt, i) => {
    let mid = (prev[i] && prev[i].memberId) || null;
    if (!mid || used.has(mid)) mid = (i === 0 && !used.has(z.memberId || S.me.id)) ? (z.memberId || S.me.id) : (members.find(m => !used.has(m)) || null);
    if (mid) used.add(mid);
    return Object.assign({}, rt, { memberId: mid, memberName: mid ? memberName(mid) : null });
  });
  delete z.route; z.unreached = r.unreached; z.updated = Date.now();
  persist(); renderRoutes(); renderZoneList(); broadcastZones();
  if (!quiet) {
    const maxLen = Math.max(...z.routes.map(x => x.len));
    toast(k === 1 ? t('route.made', { len: fmtDist(maxLen), extra: fmtDist(z.routes[0].extra), min: Math.round(maxLen / 80) }) : t('route.madeK', { k, max: fmtDist(maxLen), min: Math.round(maxLen / 80) }));
    if (r.unreached > 0) toast(t('route.unreached', { len: fmtDist(r.unreached) }), 'warn');
    openZoneEditor(z.id);
  }
}
// 내 위치에서 바로 / 재계산: 출발점을 그 자리로 두고, 1명 경로(내 것)만 다시 만든다. 다른 사람 경로는 그대로.
function computeRoute(zid, start) {
  const z = S.sess.zones.find(x => x.id === zid); if (!z || !z.segs || !z.segs.length) return;
  const rs = zoneRoutes(z);
  if (rs.length <= 1) { z.start = start; z.people = 1; computeRoutes(zid, true); if (zoneRoutes(z).length) { const r = zoneRoutes(z)[0]; r.memberId = S.me.id; r.memberName = S.me.name; persist(); toast(t('route.made', { len: fmtDist(r.len), extra: fmtDist(r.extra), min: Math.round(r.len / 80) })); startNav(z.id); } return; }
  // 여러 명 경로가 있을 때: 내 경로가 지나는 골목 중 아직 안 돈 것만 다시
  const mine = myRoute(z); if (!mine) { toast(t('route.noMine'), 'warn'); return; }
  const mySegKeys = new Set(); for (const s of z.segs) { for (let i = 1; i < mine.coords.length; i++) { if (Geo.pointToSegment([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], mine.coords[i - 1], mine.coords[i]) < 3) { mySegKeys.add(s.key); break; } } }
  const req = new Set([...mySegKeys].filter(k => !S.coverage[k]));
  if (!req.size) { toast(t('route.allDone'), 'warn'); return; }
  let r; try { r = Route.plan(z.segs, start, req, z.meet || null, 1); } catch (e) { r = null; }
  if (!r) { toast(t('route.fail'), 'err'); return; }
  Object.assign(mine, r, { memberId: S.me.id, memberName: S.me.name }); z.updated = Date.now();
  persist(); renderRoutes(); broadcastZones();
  toast(t('route.made', { len: fmtDist(r.len), extra: fmtDist(r.extra), min: Math.round(r.len / 80) }));
  startNav(z.id);
}
function routeListHtml(z) {
  const rs = zoneRoutes(z); if (!rs.length) return '';
  const ids = [S.me.id, ...Object.keys(S.members)];
  for (const r of rs) if (r.memberId && !ids.includes(r.memberId)) ids.push(r.memberId);
  return rs.map((r, i) => `<div class="route-row"><span class="sw" style="background:${ROUTE_COLORS[i % ROUTE_COLORS.length]}"></span><b>${i + 1}</b><span>${fmtDist(r.len)} · ${Math.round(r.len / 80)}${t('zone.est.min')}</span>
    <select data-ri="${i}"><option value="">${t('zone.unassigned')}</option>${ids.map(m => `<option value="${m}" ${r.memberId === m ? 'selected' : ''}>${esc(m === r.memberId ? (memberName(m) !== '?' ? memberName(m) : (r.memberName || '?')) : memberName(m))}</option>`).join('')}</select></div>`).join('')
    + (z.meet ? '' : `<div class="help">${t('route.noMeetHint')}</div>`);
}
// 경로 그리기. 선은 흰 테두리 + 검정(팀원 색·지도 색 어느 것과도 안 겹침), 지나온 구간은 회색.
// 회전 지점은 화살표 아이콘으로, 지금 위치부터 앞쪽 12개만, 화면에서 서로 겹치면 뒤쪽 것은 숨긴다 (확대하면 나타남).
const STEP_GLYPH = { left: '↰', right: '↱', uturn: '↶' };
function renderRoutes() {
  LG.route.clearLayers();
  const placed = [];
  const canPlace = ll => { const p = map.latLngToLayerPoint(ll); for (const q of placed) if (Math.abs(p.x - q.x) < 26 && Math.abs(p.y - q.y) < 26) return false; placed.push(p); return true; };
  const line = (pts, color, w, dash, op) => { L.polyline(pts, { color: '#fff', weight: w + 5, opacity: op, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(LG.route); L.polyline(pts, { color, weight: w, opacity: op, dashArray: dash, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(LG.route); };
  const mk = (ll, html, size, cls) => L.marker(ll, { icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), interactive: false, zIndexOffset: cls === 'next' ? 500 : 0 }).addTo(LG.route);
  for (const z of S.sess.zones) {
    if (z.deleted) continue;
    // 출발점·집결지 핀 (드래그 가능)
    if (S.layers.steps) for (const kind of ['start', 'meet']) {
      if (!z[kind]) continue;
      const pin = L.marker(z[kind], { icon: L.divIcon({ className: '', html: `<div class="pin ${kind}"><span>${kind === 'start' ? 'S' : '🏁'}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }), draggable: true, zIndexOffset: 600 }).addTo(LG.route);
      pin.bindTooltip(t(kind === 'start' ? 'pin.start' : 'pin.meet') + ' · ' + t('pin.drag'), { direction: 'top', offset: [0, -28] });
      pin.on('dragend', ev => { const ll = ev.target.getLatLng(); setPin(z.id, kind, [ll.lat, ll.lng], true); });
      placed.push(map.latLngToLayerPoint(z[kind]));
    }
    const rs = zoneRoutes(z); if (!rs.length) continue;
    const mineR = myRoute(z);
    const navHere = S.nav && S.nav.zoneId === z.id && mineR;
    rs.forEach((r, i) => {
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      const isMine = r === mineR;
      const c = r.coords;
      if (navHere && isMine) {
        const pos = S.nav.pos;
        if (pos > 0) line(c.slice(0, pos + 1), '#9ca3af', 4, null, 0.85);
        line(c.slice(pos), color, 4.5, null, 0.95);
      } else line(c, color, isMine ? 4 : 3, null, isMine ? 0.95 : 0.8);
      // 경로 번호 라벨 (1/3 지점)
      if (rs.length > 1 && S.layers.steps) { const li = Math.floor(c.length / 3); mk(c[li], `<div class="route-label" style="border-color:${color};color:${color}">${i + 1}${r.memberName ? ' ' + esc(r.memberName) : ''}</div>`, 24); }
    });
    if (!S.layers.steps || !navHere) continue;
    // 내 경로의 회전 지점
    const c = mineR.coords, steps = mineR.steps, pos = S.nav.pos;
    if (!z.meet) { mk(c[c.length - 1], `<div class="route-step end">E</div>`, 22); canPlace(c[c.length - 1]); }
    let n = 0, shown = 0; const nextStep = steps.find(s => s.i > pos && s.type !== 'end');
    for (const st of steps) {
      if (st.type === 'start' || st.type === 'end') continue;
      n++;
      if (st.i <= pos || shown >= 12) continue;
      const isNext = st === nextStep;
      if (!isNext && !canPlace(c[st.i])) continue;
      if (isNext) placed.push(map.latLngToLayerPoint(c[st.i]));
      mk(c[st.i], `<div class="route-step turn ${isNext ? 'next' : ''}"><span class="g">${STEP_GLYPH[st.type] || '•'}</span><span class="n">${n}</span></div>`, isNext ? 34 : 26, isNext ? 'next' : '');
      shown++;
    }
  }
  if (SIM.layer && map.hasLayer(SIM.layer)) SIM.layer.bringToFront && SIM.layer.bringToFront();
}

// ---------- 동시 이동 시뮬레이션 ----------
const SIM = { zoneId: null, timer: null, walkers: [], t: 0, speed: 30, layer: L.layerGroup(), done: false };
const SIM_WALK = 1.0;   // m/s: 전단 넣으면서 걷는 평균 (徒歩80m/分 보다 느리게)
function simStart(zid) {
  simStop();
  const z = S.sess.zones.find(x => x.id === zid); const rs = z ? zoneRoutes(z) : []; if (!rs.length) return;
  SIM.zoneId = zid; SIM.t = 0; SIM.done = false; SIM.walkers = [];
  SIM.layer.addTo(map);
  rs.forEach((r, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const cum = [0]; for (let k = 1; k < r.coords.length; k++) cum.push(cum[k - 1] + Geo.dist(r.coords[k - 1], r.coords[k]));
    const w = { r, i, color, d: 0, cum, len: cum[cum.length - 1], finish: null, name: r.memberName || (i + 1),
      marker: L.marker(r.coords[0], { icon: L.divIcon({ className: '', html: `<div class="sim-walker" style="background:${color}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, zIndexOffset: 800 }).addTo(SIM.layer),
      trail: L.polyline([r.coords[0]], { color, weight: 5, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(SIM.layer) };
    SIM.walkers.push(w);
  });
  $('#sim-bar').classList.remove('hidden'); document.body.classList.add('nav-on');
  $$('#sim-actions [data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === SIM.speed));
  if (S.layers.myTrack || S.layers.otherTracks) { /* 발자취는 그대로 두고 시뮬레이션 레이어를 위에 */ }
  map.fitBounds(L.latLngBounds(rs.flatMap(r => r.coords)), { padding: [40, 40] });
  SIM.timer = setInterval(simTick, 100);
  simRender();
}
function simStop() { if (SIM.timer) clearInterval(SIM.timer); SIM.timer = null; SIM.layer.clearLayers(); if (map.hasLayer(SIM.layer)) map.removeLayer(SIM.layer); SIM.zoneId = null; $('#sim-bar').classList.add('hidden'); if (!S.nav) document.body.classList.remove('nav-on'); }
function simSpeed(v) { SIM.speed = v; $$('#sim-actions [data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === v)); }
function simPosAt(w, d) {
  const c = w.r.coords, cum = w.cum;
  if (d >= w.len) return c[c.length - 1];
  let k = 1; while (k < cum.length && cum[k] < d) k++;
  const f = (d - cum[k - 1]) / Math.max(0.01, cum[k] - cum[k - 1]);
  return [c[k - 1][0] + (c[k][0] - c[k - 1][0]) * f, c[k - 1][1] + (c[k][1] - c[k - 1][1]) * f];
}
function simTick() {
  const dt = 0.1 * SIM.speed; SIM.t += dt;
  let allDone = true;
  for (const w of SIM.walkers) {
    if (w.finish != null) continue;
    w.d = Math.min(w.len, w.d + dt * SIM_WALK);
    const p = simPosAt(w, w.d); w.marker.setLatLng(p); w.trail.addLatLng(p);
    if (w.d >= w.len) w.finish = SIM.t; else allDone = false;
  }
  simRender();
  if (allDone && !SIM.done) { SIM.done = true; clearInterval(SIM.timer); SIM.timer = null; }
}
function simRender() {
  const mm = Math.floor(SIM.t / 60), ss = Math.floor(SIM.t % 60);
  const maxFin = SIM.walkers.every(w => w.finish != null) ? Math.max(...SIM.walkers.map(w => w.finish)) : null;
  $('#sim-text').textContent = maxFin != null ? t('sim.done', { min: Math.round(maxFin / 60) }) : `${t('sim.title')} ×${SIM.speed} · ${t('sim.elapsed')} ${mm}:${String(ss).padStart(2, '0')}`;
  $('#sim-walkers').innerHTML = SIM.walkers.map(w => `<span class="w"><i class="sw" style="background:${w.color}"></i>${w.i + 1} ${esc(w.name)} ${w.finish != null ? '✓ ' + Math.round(w.finish / 60) + t('zone.est.min') : Math.round(w.d / w.len * 100) + '%'}</span>`).join('');
}
function startNav(zid) {
  const z = S.sess.zones.find(x => x.id === zid); if (!z || !myRoute(z)) { toast(t('route.noMine'), 'warn'); return; }
  S.nav = { zoneId: zid, pos: 0 };
  $('#nav-bar').classList.remove('hidden'); $('#nav-bar').classList.remove('mini'); document.body.classList.add('nav-on'); document.body.classList.remove('nav-mini');
  if (!S.layers.route) setLayer('route', true);
  renderRoutes(); updateNav(S.myPos);
  if (!S.tracking) toast(t('route.startTracking'), 'warn');
}
function stopNav() { S.nav = null; $('#nav-bar').classList.add('hidden'); document.body.classList.remove('nav-on'); document.body.classList.remove('nav-mini'); renderRoutes(); }
const NAV_ICON = { left: '↰', right: '↱', uturn: '↶', end: '🏁', start: '▲', straight: '↑' };
// 진행 위치(pos = 지금 걷고 있는 경로 구간의 시작 꼭짓점). 순차적으로만 전진한다:
//  - 다음 꼭짓점 15m 안에 들어오면 한 칸 전진 (연속으로 여러 칸 가능)
//  - 현재 구간에서 20m 이내면 유지
//  - 둘 다 아니면 앞쪽 25구간 중 처음으로 20m 이내인 구간으로 재동기화
// 같은 교차로를 두 번 지나는 경로에서 '뒤쪽 통과'를 '앞쪽 통과'로 착각해 건너뛰지 않게 하기 위함.
function updateNav(pt) {
  if (!S.nav) return;
  const z = S.sess.zones.find(x => x.id === S.nav.zoneId); const route = z && myRoute(z); if (!route) { stopNav(); return; }
  const c = route.coords;
  if (pt) {
    let i = S.nav.pos;
    // 현재 구간의 끝까지 8m 이내로 왔을 때만 다음 구간으로 (막다른 골목 왕복 구간에서 중간에 건너뛰지 않게)
    const remainOnSeg = k => { const A = Geo.toXY(c[k], pt), B = Geo.toXY(c[k + 1], pt); const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy; const L = Math.sqrt(l2); if (!L) return 0; const tt = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / l2)); return L * (1 - tt); };
    while (i < c.length - 1 && remainOnSeg(i) <= 8 && Geo.pointToSegment(pt, c[i], c[i + 1]) <= 20) i++;
    if (i === S.nav.pos && i < c.length - 1 && Geo.pointToSegment(pt, c[i], c[i + 1]) > 20) {
      for (let j = i + 1; j < Math.min(c.length - 1, i + 25); j++) if (Geo.pointToSegment(pt, c[j], c[j + 1]) <= 20) { i = j; break; }
    }
    if (i > S.nav.pos) { S.nav.pos = i; renderRoutes(); }
  }
  const pos = S.nav.pos;
  const next = route.steps.find(s => s.i > pos) || route.steps[route.steps.length - 1];
  let dToNext = pt ? Geo.dist(pt, c[pos]) : 0; for (let i = pos; i < next.i; i++) dToNext += Geo.dist(c[i], c[i + 1]);
  let remain = dToNext; for (let i = next.i; i < c.length - 1; i++) remain += Geo.dist(c[i], c[i + 1]);
  const off = pt && pos < c.length - 1 && Geo.pointToSegment(pt, c[pos], c[pos + 1]) > 40;
  $('#nav-ico').textContent = NAV_ICON[next.type] || '↑';
  const stepNo = route.steps.filter(s => s.type !== 'start' && s.type !== 'end').indexOf(next) + 1;
  $('#nav-text').textContent = off ? t('route.offRoute') : `${stepNo > 0 ? stepNo + '. ' : ''}${t('route.' + next.type)} · ${Math.round(dToNext)} m`;
  $('#nav-sub').textContent = `${t('route.remaining')} ${fmtDist(remain)} · ${Math.round(remain / 80)}${t('zone.est.min')} · ${z.name}`;
  if (next.type === 'end' && pt && Geo.dist(pt, c[c.length - 1]) < 15) { toast(t('route.arrived')); }
}

// ---------- 표시(POI) ----------
function startPoi() {
  cancelDraw();
  const items = Object.keys(POI_TYPES).map(k => `<button class="btn block" data-poi="${k}">${POI_TYPES[k]} ${t('poi.' + k)}</button>`).join('');
  openModal(`<h3>${t('tab.pois')}</h3>${items}`);
  $$('#modal [data-poi]').forEach(b => b.onclick = () => { closeModal(); S.poiMode = b.dataset.poi; $('#poi-bar').classList.remove('hidden'); $('#fab-poi').classList.add('active'); collapseSheet(); });
}
function cancelPoi() { S.poiMode = null; $('#poi-bar').classList.add('hidden'); $('#fab-poi').classList.remove('active'); }
function placePoi(ll) {
  const type = S.poiMode; cancelPoi();
  openModal(`<h3>${POI_TYPES[type]} ${t('poi.' + type)}</h3><div class="field"><label>${t('poi.noteLabel')}</label><input type="text" id="poi-note" maxlength="80"></div><button class="btn primary block" id="poi-ok">${t('zone.save')}</button>`);
  $('#poi-note').focus();
  $('#poi-ok').onclick = () => {
    const m = { id: Store.uid(), type, lat: ll.lat, lng: ll.lng, note: $('#poi-note').value.trim(), by: S.me.name, byId: S.me.id, t: Date.now(), updated: Date.now() };
    S.sess.markers.push(m); persist(); renderPois(); closeModal();
    if (S.sync) S.sync.send({ type: 'markers', markers: S.sess.markers });
    toast(t('toast.saved'));
  };
}
function renderPois() {
  LG.pois.clearLayers();
  const ms = S.sess.markers.filter(m => !m.deleted);
  for (const m of ms) {
    const mk = L.marker([m.lat, m.lng], { icon: L.divIcon({ className: 'poi-icon', html: POI_TYPES[m.type] || '📍', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(LG.pois);
    mk.bindPopup(`<b>${POI_TYPES[m.type]} ${esc(t('poi.' + m.type))}</b><br>${esc(m.note || '')}<br><small>${esc(m.by)} · ${fmtTime(m.t)}</small><br><button class="btn small danger" data-del-poi="${m.id}">${t('zone.delete')}</button>`);
    mk.on('popupopen', () => { const b = document.querySelector(`[data-del-poi="${m.id}"]`); if (b) b.onclick = () => deletePoi(m.id); });
  }
  const el = $('#tab-pois');
  let h = `<p class="help">${t('pois.help')}</p>`;
  if (!ms.length) h += `<div class="empty">${t('pois.empty')}</div>`;
  for (const m of ms.slice().reverse()) h += `<div class="row clickable" data-poi-go="${m.id}"><span style="font-size:20px">${POI_TYPES[m.type]}</span><div class="grow"><div class="name">${esc(t('poi.' + m.type + '.s'))} ${esc(m.note || '')}</div><div class="meta">${esc(m.by)} · ${fmtTime(m.t)}</div></div></div>`;
  el.innerHTML = h;
  $$('#tab-pois [data-poi-go]').forEach(r => r.onclick = () => { const m = ms.find(x => x.id === r.dataset.poiGo); map.setView([m.lat, m.lng], Math.max(map.getZoom(), 17)); collapseSheet(); });
}
function deletePoi(id) {
  if (!confirm(t('poi.deleteConfirm'))) return;
  const m = S.sess.markers.find(x => x.id === id); if (!m) return;
  m.deleted = true; m.updated = Date.now(); map.closePopup(); persist(); renderPois();
  if (S.sync) S.sync.send({ type: 'markers', markers: S.sess.markers });
}

// ---------- 팀 패널 ----------
function renderTeam() {
  const el = $('#tab-team'); if (!el || !S.me || !S.sess) return;
  const rows = [{ id: S.me.id, name: S.me.name, color: S.me.color, me: true, tracking: S.tracking, seen: Date.now(), lat: S.myPos && S.myPos.lat, lng: S.myPos && S.myPos.lng }]
    .concat(Object.values(S.members));
  let h = `<p class="help">${t('team.help')}</p>`;
  for (const m of rows) {
    const pts = S.tracks[m.id] || [];
    const stale = !m.me && Date.now() - (m.seen || 0) > STALE_MS;
    const status = stale ? `<span class="pill">${t('team.offline')}</span>` : (m.tracking ? `<span class="pill on">${t('team.tracking')}</span>` : `<span class="pill">${t('team.idle')}</span>`);
    const ms = memberStats(m.id);
    const ovm = m.me ? Math.round(S.ovMeters) : null;
    h += `<div class="row"><span class="swatch" style="background:${m.color}"></span><div class="grow"><div class="name">${esc(m.name)}${m.me ? ' <small>(' + t('team.me') + ')</small>' : ''} ${status}</div>
      <div class="meta">${fmtDist(ms.dist)} · ${ms.steps.toLocaleString()}${t('hud.steps')} · ${t('team.houses')} ${ms.houses} · ${t('team.flyers')} ≈${ms.flyers}${ovm ? ` · <span style="color:var(--danger)">${t('team.overlap')} ${ovm}m</span>` : ''}${!m.me && m.seen ? ' · ' + t('team.lastSeen') + ' ' + fmtTime(m.seen) : ''}</div></div>
      ${m.lat != null ? `<button class="btn small" data-goto="${m.id}">◎</button>` : ''}</div>`;
  }
  h += `<div class="btn-row"><button class="btn small" id="tm-bot">${t('team.addBot')}</button>${S.bots.length ? `<button class="btn small" id="tm-nobot">${t('team.removeBots')}</button>` : ''}</div>`;
  el.innerHTML = h;
  $$('#tab-team [data-goto]').forEach(b => b.onclick = () => { const m = b.dataset.goto === S.me.id ? S.myPos : S.members[b.dataset.goto]; if (m) { map.setView([m.lat, m.lng], Math.max(map.getZoom(), 17)); collapseSheet(); } });
  $('#tm-bot').onclick = addBot;
  if ($('#tm-nobot')) $('#tm-nobot').onclick = removeBots;
}

// ---------- 데모 팀원 (시연용 가상 걷기) ----------
function addBot() {
  const n = S.bots.length + 1; const id = 'bot-' + n;
  const c = S.myPos || map.getCenter();
  const bot = { id, name: t('bot.name') + ' ' + n, color: COLORS[(n + 3) % COLORS.length], lat: c.lat + (Math.random() - .5) * 0.004, lng: c.lng + (Math.random() - .5) * 0.004, dir: Math.random() * Math.PI * 2, t: Date.now() };
  S.bots.push(bot);
  S.members[id] = { id, name: bot.name, color: bot.color, lat: bot.lat, lng: bot.lng, t: Date.now(), tracking: true, seen: Date.now(), bot: true };
  renderMember(id); renderTeam();
  if (!S.botTimer) S.botTimer = setInterval(stepBots, 2000);
}
function stepBots() {
  for (const b of S.bots) {
    if (Math.random() < 0.25) b.dir += (Math.random() - .5) * Math.PI / 2;    // 모퉁이 돌기
    const step = 1.3 * 2;                                                       // 1.3 m/s × 2초
    b.lat += Geo.mToLat(step * Math.cos(b.dir)); b.lng += Geo.mToLng(step * Math.sin(b.dir), b.lat); b.t = Date.now();
    const p = { lat: b.lat, lng: b.lng, t: b.t, acc: 8 };
    onRemote({ type: 'presence', member: { id: b.id, name: b.name, color: b.color, lat: b.lat, lng: b.lng, t: b.t, tracking: true } });
    onRemote({ type: 'track', memberId: b.id, points: [p] });
  }
}
function removeBots() {
  clearInterval(S.botTimer); S.botTimer = null;
  for (const b of S.bots) {
    delete S.members[b.id]; delete S.tracks[b.id];
    if (memberMarkers[b.id]) { LG.members.removeLayer(memberMarkers[b.id]); delete memberMarkers[b.id]; }
    const tl = trackLayers[b.id]; if (tl) { LG.tracks.removeLayer(tl.halo); LG.tracks.removeLayer(tl.core); tl.ov.forEach(l => LG.tracks.removeLayer(l)); delete trackLayers[b.id]; }
    for (const k in S.coverage) if (S.coverage[k] === b.id) delete S.coverage[k];
    for (const k in S.passes) delete S.passes[k][b.id];
  }
  S.bots = []; rebuildGrid(); renderStreets(); renderZones(); renderTeam(); persist();
}

// ---------- 설정 패널 ----------
function renderSettings() {
  const el = $('#tab-settings');
  el.innerHTML = `
    <div class="section-title">${t('set.me')}</div>
    <div class="field"><label>${t('set.name')}</label><input type="text" id="st-name" value="${esc(S.me ? S.me.name : '')}" maxlength="20"></div>
    <div class="field"><label>${t('set.color')}</label><div class="colors" id="st-colors">${COLORS.map(c => `<span style="background:${c}" data-c="${c}" class="${S.me && c === S.me.color ? 'sel' : ''}"></span>`).join('')}</div></div>
    <div class="field"><label>${t('set.session')}</label><input type="text" id="st-code" value="${esc(S.code || '')}" maxlength="24"><div class="help">${t('set.sessionHelp')}</div></div>
    <button class="btn primary block" id="st-apply">${t('set.apply')}</button>

    <div class="section-title">${t('set.sync')}</div>
    <div class="field"><select id="st-sync"><option value="local" ${S.syncKind === 'local' ? 'selected' : ''}>${t('set.sync.local')}</option><option value="firebase" ${S.syncKind === 'firebase' ? 'selected' : ''}>${t('set.sync.firebase')}</option></select></div>
    <div class="field ${S.syncKind === 'firebase' ? '' : 'hidden'}" id="st-fb-wrap"><label>${t('set.firebaseCfg')}</label><textarea id="st-fb" placeholder='{"apiKey":"...","databaseURL":"https://....firebasedatabase.app",...}'>${esc(S.firebaseCfg ? JSON.stringify(S.firebaseCfg, null, 1) : '')}</textarea><div class="help">${t('set.firebaseHelp')}</div></div>

    <div class="section-title">${t('set.map')}</div>
    <div class="field"><select id="st-tile">${Object.keys(VECTOR).concat(Object.keys(TILES)).map(k => `<option value="${k}" ${S.tile === k ? 'selected' : ''}>${t('set.tile.' + k)}</option>`).join('')}</select></div>
    <div class="field inline"><label>${t('set.labelLang')}</label><select id="st-label" style="width:150px">${['ja', 'ko', 'ko_ja', 'latin_ja'].map(k => `<option value="${k}" ${S.labelLang === k ? 'selected' : ''}>${t('set.labelLang.' + k)}</option>`).join('')}</select></div>
    <div class="help">${t('set.labelLangHelp')}</div>
    <div class="field inline"><label>${t('set.ovRadius')}</label><input type="number" id="st-ov" value="${S.ovRadius}" min="5" max="50" style="width:80px"></div>
    <div class="field inline"><label>${t('set.coverRadius')}</label><input type="number" id="st-cov" value="${S.coverRadius}" min="5" max="40" style="width:80px"></div>
    <div class="field inline"><label>${t('set.stride')}</label><input type="number" id="st-stride" value="${S.stride}" min="40" max="100" style="width:80px"></div>
    <div class="field inline"><label>${t('set.sim')}</label><label class="switch"><input type="checkbox" id="st-sim" ${S.sim ? 'checked' : ''}><i></i></label></div>
    <div class="field inline"><label>${t('set.lang')}</label><select id="st-lang" style="width:120px"><option value="ko" ${S.lang === 'ko' ? 'selected' : ''}>한국어</option><option value="ja" ${S.lang === 'ja' ? 'selected' : ''}>日本語</option></select></div>

    <div class="section-title">${t('set.data')}</div>
    <div class="btn-row"><button class="btn small" id="st-export">${t('set.export')}</button><button class="btn small" id="st-exportgeo">${t('set.exportGeo')}</button><button class="btn small" id="st-import">${t('set.import')}</button><input type="file" id="st-file" accept=".json,application/json" class="hidden"></div>
    <div class="btn-row"><button class="btn small danger" id="st-cleartracks">${t('set.clearTracks')}</button><button class="btn small danger" id="st-clearall">${t('set.clearAll')}</button></div>

    <div class="section-title">${t('set.about')}</div>
    <p class="help">${t('set.privacy')}</p>
    <p class="help"><a href="LICENSES.md" target="_blank" rel="noopener">${t('set.license')}</a> · 지도: OpenFreeMap © OpenMapTiles © OpenStreetMap contributors / 地理院タイル · Leaflet (BSD-2) · MapLibre (BSD-3)</p>`;

  let color = S.me.color;
  $('#st-colors').addEventListener('click', e => { const s = e.target.closest('span[data-c]'); if (!s) return; color = s.dataset.c; $$('#st-colors span').forEach(x => x.classList.toggle('sel', x === s)); });
  $('#st-apply').onclick = () => {
    const name = $('#st-name').value.trim() || S.me.name; const code = normCode($('#st-code').value) || S.code;
    const kind = $('#st-sync').value; let cfg = S.firebaseCfg;
    if (kind === 'firebase') { try { cfg = JSON.parse($('#st-fb').value); if (!cfg.databaseURL) throw 0; } catch (e) { toast(t('toast.firebaseBad'), 'err'); return; } }
    Store.set('me', { id: S.me.id.split('.')[0], name, color });
    S.syncKind = kind; S.firebaseCfg = cfg; Store.set('syncKind', kind); Store.set('firebaseCfg', cfg);
    S.me = withTabId({ id: S.me.id, name, color });
    joinSession(code); toast(t('toast.saved'));
  };
  $('#st-sync').onchange = e => $('#st-fb-wrap').classList.toggle('hidden', e.target.value !== 'firebase');
  $('#st-tile').onchange = e => { setTile(e.target.value); Store.set('tile', e.target.value); };
  $('#st-label').onchange = e => setLabelLang(e.target.value);
  $('#st-ov').onchange = e => { S.ovRadius = Math.max(5, Math.min(50, +e.target.value || 15)); Store.set('ovRadius', S.ovRadius); };
  $('#st-stride').onchange = e => { S.stride = Math.max(40, Math.min(100, +e.target.value || 70)); Store.set('stride', S.stride); updateHud(); renderTeam(); };
  $('#st-cov').onchange = e => { S.coverRadius = Math.max(5, Math.min(40, +e.target.value || 12)); Store.set('coverRadius', S.coverRadius); updateHaloWeights(); };
  $('#st-sim').onchange = e => { S.sim = e.target.checked; Store.set('sim', S.sim); if (S.tracking) { stopTracking(); startTracking(); } };
  $('#st-lang').onchange = e => { S.lang = e.target.value; Store.set('lang', S.lang); window.i18nLang = S.lang; applyI18n(); renderAll(); if (S.tracking) $('#fab-track .fab-lbl').textContent = t('track.stop'); };
  $('#st-export').onclick = () => download(`footprints-${S.code}.json`, JSON.stringify({ code: S.code, exported: Date.now(), zones: S.sess.zones.map(Sync.stripZone), markers: S.sess.markers, tracks: S.tracks, coverage: S.coverage, members: Object.assign({ [S.me.id]: S.me }, S.members) }, null, 1));
  $('#st-exportgeo').onclick = () => download(`footprints-${S.code}.geojson`, JSON.stringify(toGeoJSON()));
  $('#st-import').onclick = () => $('#st-file').click();
  $('#st-file').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { importJSON(JSON.parse(r.result)); } catch (err) { toast(t('toast.importFail'), 'err'); } }; r.readAsText(f); };
  $('#st-cleartracks').onclick = () => { if (!confirm(t('set.clearConfirm'))) return; S.tracks[S.me.id] = []; S.lastPt = null; S.ovMeters = 0; drawTrack(S.me.id, true); persist(); updateHud(); renderTeam(); };
  $('#st-clearall').onclick = () => { if (!confirm(t('set.clearConfirm'))) return; Store.del('session.' + S.code); location.reload(); };
}
function importJSON(d) {
  if (!d || !Array.isArray(d.zones)) throw new Error('bad');
  mergeZones(d.zones); mergeMarkers(d.markers || []); mergeCoverage(d.coverage || {});
  for (const id in (d.tracks || {})) { if (id === S.me.id) { S.tracks[id] = d.tracks[id]; drawTrack(id, true); } else replaceTrack(id, d.tracks[id]); if (d.members && d.members[id] && id !== S.me.id) S.members[id] = Object.assign({ seen: 0 }, d.members[id]); }
  persist(); renderAll(); toast(t('toast.imported'));
}
function toGeoJSON() {
  const f = [];
  for (const z of S.sess.zones) if (!z.deleted) f.push({ type: 'Feature', properties: { kind: 'zone', name: z.name, assignee: z.memberId ? memberName(z.memberId) : null, households: zoneStats(z).hh, progress: zoneStats(z).pct }, geometry: { type: 'Polygon', coordinates: [z.latlngs.concat([z.latlngs[0]]).map(p => [p[1], p[0]])] } });
  for (const id in S.tracks) if (S.tracks[id].length > 1) f.push({ type: 'Feature', properties: { kind: 'track', member: memberName(id), color: memberColor(id), points: S.tracks[id].length }, geometry: { type: 'LineString', coordinates: S.tracks[id].map(p => [p.lng, p.lat]) } });
  for (const m of S.sess.markers) if (!m.deleted) f.push({ type: 'Feature', properties: { kind: 'marker', type: m.type, note: m.note, by: m.by, time: new Date(m.t).toISOString() }, geometry: { type: 'Point', coordinates: [m.lng, m.lat] } });
  return { type: 'FeatureCollection', features: f };
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- UI 공통 ----------
function renderAll() {
  renderZones(); renderStreets(); renderRoutes(); renderPois(); renderTeam(); renderSettings();
  for (const id in S.tracks) drawTrack(id, true);
  for (const id in S.members) renderMember(id);
  applyLayers();
}
function onMapClick(e) {
  if (S.draw) { drawAdd(e.latlng); return; }
  if (S.routeMode) { const zid = S.routeMode; cancelRouteMode(); computeRoute(zid, [e.latlng.lat, e.latlng.lng]); return; }
  if (S.pinMode) { const pm = S.pinMode; cancelPinMode(); setPin(pm.zoneId, pm.kind, [e.latlng.lat, e.latlng.lng]); return; }
  if (S.poiMode) { placePoi(e.latlng); return; }
  if (S.sim && S.tracking) { acceptPoint({ lat: e.latlng.lat, lng: e.latlng.lng, acc: 5, t: Date.now() }); return; }
  if (S.sim && !S.tracking) { S.myPos = { lat: e.latlng.lat, lng: e.latlng.lng, acc: 5, t: Date.now() }; updateMyMarker(S.myPos); }
}
function bindUI() {
  $('#fab-track').onclick = () => S.tracking ? stopTracking() : startTracking();
  $('#fab-zone').onclick = () => S.draw ? cancelDraw() : startDraw();
  $('#fab-poi').onclick = () => S.poiMode ? cancelPoi() : startPoi();
  // ◎: 한 번 = 내 위치로 이동 + 따라가기 켜기, 다시 = 따라가기 끄기
  $('#fab-locate').onclick = () => {
    if (S.follow) { setFollow(false); return; }
    if (S.myPos) { map.setView([S.myPos.lat, S.myPos.lng], Math.max(map.getZoom(), 17)); setFollow(true); }
    else if (!S.sim && navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { S.myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; updateMyMarker(S.myPos); map.setView([S.myPos.lat, S.myPos.lng], 17); setFollow(true); }, () => toast(t('toast.geoDenied'), 'err'), { enableHighAccuracy: true, timeout: 10000 });
    else toast(t('poi.gpsNeeded'), 'warn');
  };
  $('#fab-layers').onclick = toggleLayersPop;
  $$('#layers-pop input[data-layer]').forEach(cb => cb.onchange = () => setLayer(cb.dataset.layer, cb.checked));
  $('#nav-toggle-route').onclick = () => setLayer('route', !S.layers.route);
  $('#nav-recalc').onclick = () => { if (!S.nav) return; const zid = S.nav.zoneId; if (!S.myPos) { toast(t('poi.gpsNeeded'), 'warn'); return; } computeRoute(zid, [S.myPos.lat, S.myPos.lng]); };
  $('#nav-mini').onclick = e => { e.stopPropagation(); $('#nav-bar').classList.add('mini'); document.body.classList.add('nav-mini'); };
  $('#nav-row').onclick = e => { if (e.target.id === 'nav-close') return; $('#nav-bar').classList.remove('mini'); document.body.classList.remove('nav-mini'); };
  document.addEventListener('click', e => { if (!e.target.closest('#layers-pop') && !e.target.closest('#fab-layers')) $('#layers-pop').classList.add('hidden'); });
  $('#draw-undo').onclick = drawUndo; $('#draw-done').onclick = finishDraw; $('#draw-cancel').onclick = cancelDraw;
  $('#poi-cancel').onclick = cancelPoi;
  $('#route-cancel').onclick = () => { cancelRouteMode(); cancelPinMode(); };
  $('#route-here').onclick = () => {
    if (!S.myPos) { toast(t('poi.gpsNeeded'), 'warn'); return; }
    if (S.pinMode) { const pm = S.pinMode; cancelPinMode(); setPin(pm.zoneId, pm.kind, [S.myPos.lat, S.myPos.lng]); return; }
    const zid = S.routeMode; cancelRouteMode(); computeRoute(zid, [S.myPos.lat, S.myPos.lng]);
  };
  $('#sim-close').onclick = simStop;
  $$('#sim-actions [data-speed]').forEach(b => b.onclick = () => simSpeed(+b.dataset.speed));
  $('#sim-restart').onclick = () => { if (SIM.zoneId) simStart(SIM.zoneId); };
  $('#nav-close').onclick = stopNav;
  $('#poi-here').onclick = () => { if (S.myPos) placePoi(S.myPos); else toast(t('poi.gpsNeeded'), 'warn'); };
  $('#sheet-handle').onclick = toggleSheet; $('#btn-menu').onclick = toggleSheet;
  $$('#tabs button').forEach(b => b.onclick = () => { $$('#tabs button').forEach(x => x.classList.toggle('active', x === b)); $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab)); openSheet(); });
  $('#modal-backdrop').onclick = closeModal;
  window.addEventListener('beforeunload', () => { if (!S.sess) return; flushPending(); Store.saveSessionNow(S.sess); if (S.sync) S.sync.send({ type: 'bye', memberId: S.me.id }); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tracking && navigator.wakeLock && !S.wakeLock) navigator.wakeLock.request('screen').then(w => S.wakeLock = w).catch(() => {}); });
}
function toggleSheet() { $('#sheet').classList.contains('collapsed') ? openSheet() : collapseSheet(); }
function openSheet() { $('#sheet').classList.remove('collapsed'); document.body.classList.add('sheet-open'); }
function collapseSheet() { $('#sheet').classList.add('collapsed'); document.body.classList.remove('sheet-open'); }
function openModal(html) { $('#modal').innerHTML = html; $('#modal-wrap').classList.remove('hidden'); }
function closeModal() { $('#modal-wrap').classList.add('hidden'); $('#modal').innerHTML = ''; }
function toast(msg, kind) {
  const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg; $('#toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'err' ? 4000 : 2500);
}
function setGps(state) {
  const g = $('#gps'); g.className = 'gps gps-' + (state === 'sim' ? 'good' : state);
  $('#gps-text').textContent = t('gps.' + state);
}
function updateHud() {
  if (!S.me || !S.sess) return;
  const ms = memberStats(S.me.id);
  $('#hud-dist').textContent = `${fmtDist(ms.dist)} · ${ms.steps.toLocaleString()}${t('hud.steps')} · 📄≈${ms.flyers}`;
  $('#hud-ov').classList.toggle('hidden', S.ovMeters < 1); $('#hud-ov-m').textContent = Math.round(S.ovMeters);
}
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }
function fmtTime(ts) { const d = new Date(ts); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'); }

window.FM = { S, get map() { return map; }, startDraw, addBot, acceptPoint, joinSession, onRemote, computeRoute, computeRoutes, setPin, startNav, simStart, simStop, SIM, zoneRoutes }; // 콘솔 디버그용
document.addEventListener('DOMContentLoaded', boot);
})();
