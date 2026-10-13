/* 구역 안의 건물·길을 가져와 세대수와 소요 시간을 추정하고, 집을 골목에 붙인다.
 *
 * 소스:
 *  1) 国土地理院 地理院地図Vector (experimental_bvmap, z16) — 基盤地図情報. 전국 전수, 공식.
 *     building 레이어: ftCode 3101 普通建物 / 3102 堅ろう建物 / 3103 高層建物 / 3111·3112 無壁舎(차고·지붕만). 용도·층수 없음.
 *     road 레이어: 27xx 가 도로중심선 (2701 通常部, 2703 トンネル, 2704 橋・高架, 2711~ 軽車道·徒歩道), 22xx 는 도로 가장자리(사용 안 함).
 *                 rdCtg 0 国道 / 1 都道府県道 / 2 市区町村道 / 3 高速, rnkWidth 0 (<3m) / 1 (3~5.5m) / 2 (5.5~13m) / 3+ — 중심선에만 붙는다.
 *     → 길·건물 모두 지리원이 1차 소스. OSM 공용 서버가 죽어도 동작한다.
 *  2) OpenStreetMap (Overpass) — 보조. 길 이름, building=apartments 같은 태그, 학교·공원·공장 부지(그 안의 건물은 제외).
 *     播磨町 표본: OSM 건물은 실제의 약 53%만 있고, 길도 사도·막다른 골목이 빠질 수 있다.
 *
 * 추정 근거 (현장 보정 전제):
 *  - 단독주택 1동 = 1세대. 바닥면적 25㎡ 미만은 창고로 보고 0.
 *  - アパート 의심: 普通建物 중 바닥면적 130~400㎡ 이고 가늘고 긴 형태(종횡비 ≥ 2.0). 2층 × 바닥면적 ÷ 32㎡ ≈ 세대, 최소 4.
 *  - 堅ろう建物 120~1500㎡: 3층 가정, ÷65㎡, 최소 4. 1500㎡ 초과는 시설로 0. 高層建物: 8층 가정.
 *  - 普通建物 400㎡ 초과: 공장·창고·시설로 0.
 *  - 길 길이 기준 보조 추정: 생활도로 100m 당 약 15세대.
 *  - 소요 시간: 도보 80m/분 ('徒歩1分=80m'), 단독 1세대당 20초, 집합우편함 1세대당 8초 + 동당 1분.
 *  - 길 선분은 30m 이하로 잘라 '완료' 판정이 길 일부만 걷고 전체가 완료되지 않게 한다.
 */
window.Estimate = (() => {
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const GSI_BVMAP = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/16/{x}/{y}.pbf';
  const NON_RES = /^(commercial|industrial|retail|warehouse|office|school|hospital|church|temple|shrine|garage|garages|shed|hut|roof|greenhouse|barn|public|civic|government|kindergarten|university|college|train_station|transportation|service|parking|carport|construction|ruins|toilets|sports_hall|stadium|hangar|fire_station|hotel|supermarket|kiosk|farm_auxiliary|cowshed|stable)$/;
  const STREET_RE = '^(residential|living_street|unclassified|service|tertiary|secondary|primary|footway|path|pedestrian|track)$';
  const RES_STREET = /^(residential|living_street|unclassified)$/;
  const NON_RES_AREA = '^(school|kindergarten|college|university|hospital|clinic|place_of_worship|community_centre|townhall|fire_station|police|library|parking|social_facility|nursing_home|marketplace)$';
  const NON_RES_LANDUSE = '^(industrial|commercial|retail|religious|railway|cemetery|farmland|greenhouse_horticulture|construction|quarry|military)$';
  const NON_RES_LEISURE = '^(park|pitch|sports_centre|stadium|golf_course|playground|swimming_pool)$';
  const MAX_SEG = 30;   // m

  // ---------- OSM 태그 기반 분류 ----------
  function classifyBuilding(tags, areaM2) {
    const b = tags.building || 'yes';
    const levels = parseInt(tags['building:levels']) || null;
    const flats = parseInt(tags['building:flats']) || null;
    if (flats) return { type: 'apt', hh: flats };
    if (NON_RES.test(b)) return { type: 'other', hh: 0 };
    const aptLike = /^(apartments|residential|dormitory)$/.test(b) || (b === 'yes' && areaM2 > 250 && (levels || 1) >= 3) || (b === 'yes' && areaM2 > 450);
    if (aptLike) {
      const l = levels || (areaM2 > 400 ? 4 : 2);
      return { type: 'apt', hh: Math.max(2, Math.round(areaM2 * l / 65)) };
    }
    if (b === 'terrace') return { type: 'house', hh: Math.max(2, Math.round(areaM2 / 60)) };
    if (/^(house|detached|semidetached_house|bungalow|yes)$/.test(b)) {
      if (b === 'yes' && areaM2 < 25) return { type: 'other', hh: 0 };
      return { type: 'house', hh: 1 };
    }
    return { type: 'other', hh: 0 };
  }
  function tagsInformative(tags) { return tags && (tags.building !== 'yes' || tags['building:levels'] || tags['building:flats']); }

  // ---------- 지리원 건물 분류 ----------
  function classifyGsi(b) {
    const code = String(b.code || '');
    if (code === '3111' || code === '3112') return { type: 'other', hh: 0 };
    if (b.area < 25) return { type: 'other', hh: 0 };
    if (code === '3103') return { type: 'apt', hh: Math.max(8, Math.round(b.area * 8 / 65)), sus: false };
    if (code === '3102') {
      if (b.area < 120) return { type: 'house', hh: 1 };
      if (b.area > 1500) return { type: 'other', hh: 0 };
      return { type: 'apt', hh: Math.max(4, Math.round(b.area * 3 / 65)), sus: true };
    }
    if (b.area >= 130 && b.area <= 400 && b.aspect >= 2.0) return { type: 'apt', hh: Math.max(4, Math.round(b.area * 2 / 32)), sus: true };
    if (b.area > 400) return { type: 'other', hh: 0 };
    return { type: 'house', hh: 1 };
  }
  function aspectRatio(pts) {
    const ref = pts[0]; const xy = pts.map(p => Geo.toXY(p, ref));
    let best = 0, ang = 0;
    for (let i = 1; i < xy.length; i++) { const dx = xy[i].x - xy[i - 1].x, dy = xy[i].y - xy[i - 1].y, l = dx * dx + dy * dy; if (l > best) { best = l; ang = Math.atan2(dy, dx); } }
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const p of xy) { const rx = p.x * c - p.y * s, ry = p.x * s + p.y * c; minx = Math.min(minx, rx); maxx = Math.max(maxx, rx); miny = Math.min(miny, ry); maxy = Math.max(maxy, ry); }
    const w = maxx - minx, h = maxy - miny;
    return Math.max(w, h) / Math.max(1, Math.min(w, h));
  }

  // ---------- 지리원 벡터 타일 (건물 + 도로중심선) ----------
  let mvt = null;
  async function loadMvt() {
    if (mvt) return mvt;
    const [vt, pbf] = await Promise.all([import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm'), import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm')]);
    return mvt = { VectorTile: vt.VectorTile, Pbf: pbf.default };
  }
  function tileX(lng, z) { return Math.floor((lng + 180) / 360 * 2 ** z); }
  function tileY(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
  function tileBounds(x, y, z) {
    const n = 2 ** z; const lat = yy => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI;
    return { w: x / n * 360 - 180, e: (x + 1) / n * 360 - 180, n: lat(y), s: lat(y + 1) };
  }
  const inB = (p, b) => p[0] >= b.s && p[0] < b.n && p[1] >= b.w && p[1] < b.e;
  function roadClass(p) {
    // 27xx = 道路中心線 (2701 通常部, 2703 トンネル, 2704 橋・高架, 2711~ 軽車道·徒歩道). 22xx 는 道路縁(가장자리)이라 쓰지 않는다.
    // rdCtg/rnkWidth 는 중심선에만 붙는다.
    const ft = +p.ftCode || 0, cat = p.rdCtg == null ? 2 : +p.rdCtg, w = p.rnkWidth == null ? 1 : +p.rnkWidth;
    if (ft < 2700 || ft >= 2800) return null;              // 도로중심선만
    if (cat === 3) return null;                             // 고속도로
    if (ft >= 2711) return 'path';                          // 軽車道·徒歩道 등
    if (cat === 0 || cat === 1) return w >= 2 ? 'secondary' : 'tertiary';
    return w <= 2 ? 'residential' : 'tertiary';             // 시정촌도 13m 미만 = 생활도로
  }
  async function fetchGsi(poly) {
    const { VectorTile, Pbf } = await loadMvt();
    const bb = Geo.bbox(poly), Z = 16, buildings = [], roads = [];
    const jobs = [];
    for (let x = tileX(bb.w, Z); x <= tileX(bb.e, Z); x++) for (let y = tileY(bb.n, Z); y <= tileY(bb.s, Z); y++) jobs.push([x, y]);
    if (jobs.length > 30) throw new Error('zone too large');
    await Promise.all(jobs.map(async ([x, y]) => {
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
      try {
        const r = await fetch(GSI_BVMAP.replace('{x}', x).replace('{y}', y), { signal: ac.signal });
        if (!r.ok) return;
        const vt = new VectorTile(new Pbf(await r.arrayBuffer()));
        const tb = tileBounds(x, y, Z);
        const bl = vt.layers.building;
        if (bl) for (let i = 0; i < bl.length; i++) {
          const f = bl.feature(i); const g = f.toGeoJSON(x, y, Z);
          const ring = g.geometry.type === 'Polygon' ? g.geometry.coordinates[0] : g.geometry.type === 'MultiPolygon' ? g.geometry.coordinates[0][0] : null;
          if (!ring || ring.length < 4) continue;
          const pts = ring.map(c => [c[1], c[0]]);
          const c = Geo.centroid(pts);
          if (!inB([c.lat, c.lng], tb) || !Geo.pointInPolygon(c, poly)) continue;   // 타일 버퍼의 중복 제거
          buildings.push({ pts, c, code: f.properties.ftCode, area: Geo.polygonAreaM2(pts), aspect: aspectRatio(pts) });
        }
        const rl = vt.layers.road;
        if (rl) for (let i = 0; i < rl.length; i++) {
          const f = rl.feature(i); const cls = roadClass(f.properties); if (!cls) continue;
          const g = f.toGeoJSON(x, y, Z);
          const lines = g.geometry.type === 'LineString' ? [g.geometry.coordinates] : g.geometry.type === 'MultiLineString' ? g.geometry.coordinates : [];
          lines.forEach((ln, li) => roads.push({ id: `g${x}_${y}_${i}_${li}`, pts: ln.map(c => [c[1], c[0]]), hw: cls, tb }));
        }
      } finally { clearTimeout(timer); }
    }));
    return { buildings, roads };
  }

  // ---------- OSM ----------
  async function fetchOverpass(poly) {
    const polyStr = poly.map(p => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join(' ');
    const q = `[out:json][timeout:40];(way["building"](poly:"${polyStr}");way["highway"~"${STREET_RE}"](poly:"${polyStr}");way["amenity"~"${NON_RES_AREA}"](poly:"${polyStr}");way["landuse"~"${NON_RES_LANDUSE}"](poly:"${polyStr}");way["leisure"~"${NON_RES_LEISURE}"](poly:"${polyStr}"););out geom;`;
    let lastErr;
    for (const url of OVERPASS) {
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { lastErr = e; console.warn('overpass', url, e.message); }
      finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('overpass');
  }
  function osmWalkable(tg) {
    if (!tg.highway) return false;
    if (tg.highway === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(tg.service || '')) return false;
    if (tg.highway === 'footway' && (tg.footway === 'sidewalk' || tg.footway === 'crossing')) return false;
    if (tg.highway === 'path' && tg.sidewalk) return false;
    return true;
  }
  // 선분 생성: 폴리라인을 30m 이하 조각으로 자르고, 조각 중점이 구역 안(그리고 타일 안)인 것만 남긴다.
  function splitLine(zoneId, baseId, pts, hw, name, poly, tb, out) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], len = Geo.dist(a, b);
      if (len < 1) continue;
      const parts = Math.max(1, Math.ceil(len / MAX_SEG));
      for (let k = 0; k < parts; k++) {
        const pa = [a[0] + (b[0] - a[0]) * k / parts, a[1] + (b[1] - a[1]) * k / parts];
        const pb = [a[0] + (b[0] - a[0]) * (k + 1) / parts, a[1] + (b[1] - a[1]) * (k + 1) / parts];
        const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
        if (tb && !inB(mid, tb)) continue;
        if (!Geo.pointInPolygon(mid, poly)) continue;
        out.push({ key: `${zoneId}:${baseId}:${i - 1}:${k}`, a: pa, b: pb, len: len / parts, hw, name: name || '' });
      }
    }
  }

  // ---------- 합산 ----------
  async function estimateZone(zone) {
    const poly = zone.latlngs;
    const [ov, gsi] = await Promise.allSettled([fetchOverpass(poly), fetchGsi(poly)]);
    if (ov.status === 'rejected' && gsi.status === 'rejected') throw gsi.reason;
    const ways = ov.status === 'fulfilled' ? (ov.value.elements || []) : [];
    const osmOk = ov.status === 'fulfilled', gsiOk = gsi.status === 'fulfilled';
    const osmB = [];
    for (const w of ways) {
      const tg = w.tags || {};
      if (!tg.building || !w.geometry || w.geometry.length < 3) continue;
      const pts = w.geometry.map(g => [g.lat, g.lon]);
      const c = Geo.centroid(pts);
      if (!Geo.pointInPolygon(c, poly)) continue;
      osmB.push({ pts, c, tags: tg, area: Geo.polygonAreaM2(pts) });
    }
    const gsiB = gsiOk ? gsi.value.buildings : null;
    const nonResAreas = ways.filter(w => w.tags && !w.tags.building && !w.tags.highway && w.geometry && w.geometry.length > 3).map(w => w.geometry.map(g => [g.lat, g.lon]));
    const inNonRes = c => nonResAreas.some(a => Geo.pointInPolygon(c, a));

    // --- 건물 ---
    let houses = 0, apts = 0, aptUnits = 0, other = 0, buildings = 0, suspects = [];
    const blds = [];
    let src = 'osm';
    if (gsiB && gsiB.length) {
      src = 'gsi';
      for (const b of gsiB) {
        const o = osmB.find(x => Geo.pointInPolygon(x.c, b.pts));
        let c;
        if (o && tagsInformative(o.tags)) c = classifyBuilding(o.tags, b.area);
        else if (inNonRes(b.c)) c = { type: 'other', hh: 0 };
        else c = classifyGsi(b);
        if (c.type === 'other') { other++; continue; }
        buildings++;
        blds.push({ lat: +b.c.lat.toFixed(6), lng: +b.c.lng.toFixed(6), hh: c.hh, type: c.type, sus: !!c.sus });
        if (c.type === 'house') houses += c.hh;
        else { apts++; aptUnits += c.hh; if (c.sus) suspects.push({ lat: +b.c.lat.toFixed(6), lng: +b.c.lng.toFixed(6), hh: c.hh, code: b.code }); }
      }
    } else {
      for (const o of osmB) {
        const c = (!tagsInformative(o.tags) && inNonRes(o.c)) ? { type: 'other', hh: 0 } : classifyBuilding(o.tags, o.area);
        if (c.type === 'other') { other++; continue; }
        buildings++;
        blds.push({ lat: +o.c.lat.toFixed(6), lng: +o.c.lng.toFixed(6), hh: c.hh, type: c.type, sus: false });
        if (c.type === 'house') houses += c.hh; else { apts++; aptUnits += c.hh; }
      }
    }

    // --- 길: 지리원 도로중심선 우선, 없으면 OSM ---
    const osmSegs = [];
    for (const w of ways) { const tg = w.tags || {}; if (!osmWalkable(tg) || !w.geometry) continue; splitLine(zone.id, w.id, w.geometry.map(g => [g.lat, g.lon]), tg.highway, tg.name || tg['name:ja'], poly, null, osmSegs); }
    let segs = [], streetSrc = 'osm';
    if (gsiOk && gsi.value.roads.length) {
      streetSrc = 'gsi';
      for (const r of gsi.value.roads) splitLine(zone.id, r.id, r.pts, r.hw, '', poly, r.tb, segs);
      // 이름은 OSM 에서 빌린다 (8m 이내의 OSM 길)
      if (osmSegs.length) for (const s of segs) {
        const mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]; let bd = 8, nm = '';
        for (const o of osmSegs) { if (!o.name || Math.abs(o.a[0] - mid[0]) > 0.0004) continue; const d = Geo.pointToSegment(mid, o.a, o.b); if (d < bd) { bd = d; nm = o.name; } }
        s.name = nm;
      }
    } else segs = osmSegs;

    // --- 집을 가장 가까운 골목(35m)에 붙인다 ---
    for (const b of blds) {
      let best = null, bd = 35;
      for (const s of segs) {
        if (Math.abs(s.a[0] - b.lat) > 0.0006) continue;
        const d = Geo.pointToSegment(b, s.a, s.b);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) { b.seg = best.key; best.houses = (best.houses || 0) + 1; best.hh = (best.hh || 0) + b.hh; }
    }

    const streetLen = segs.reduce((s, x) => s + x.len, 0);
    const resLen = segs.filter(s => RES_STREET.test(s.hw)).reduce((s, x) => s + x.len, 0);
    const hhByBuilding = houses + aptUnits;
    const hhByStreet = Math.round(resLen / 100 * 15);
    if (!buildings) src = 'street';
    const hh = buildings ? hhByBuilding : hhByStreet;
    const minutes = Math.round(streetLen / 80 + houses * 20 / 60 + aptUnits * 8 / 60 + apts * 1);
    return {
      src, streetSrc, osmOk, gsiOk, buildings, houses, apts, aptUnits, other, suspects, blds, unassigned: blds.filter(b => !b.seg).length,
      gsiBuildings: gsiB ? gsiB.filter(b => !/^311/.test(String(b.code)) && b.area >= 25).length : null,
      osmBuildings: osmB.length,
      hhByBuilding, hhByStreet, hh, streetLen: Math.round(streetLen), resLen: Math.round(resLen), minutes, segs, at: Date.now(),
    };
  }

  return { estimateZone, classifyBuilding, classifyGsi, fetchGsi };
})();
