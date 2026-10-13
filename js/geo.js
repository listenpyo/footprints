/* 지리 계산 유틸. 모든 거리는 미터. 점은 {lat,lng} 또는 [lat,lng] 둘 다 허용. */
window.Geo = (() => {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const P = p => Array.isArray(p) ? { lat: p[0], lng: p[1] } : p;

  function dist(a, b) {
    a = P(a); b = P(b);
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // 기준점 주변의 국소 평면 좌표(m). 수 km 범위에서는 충분히 정확.
  function toXY(p, ref) {
    p = P(p); ref = P(ref);
    const kx = Math.cos(rad(ref.lat)) * 111320, ky = 110540;
    return { x: (p.lng - ref.lng) * kx, y: (p.lat - ref.lat) * ky };
  }

  function polygonAreaM2(pts) {
    if (pts.length < 3) return 0;
    const ref = P(pts[0]);
    const xy = pts.map(p => toXY(p, ref));
    let a = 0;
    for (let i = 0; i < xy.length; i++) {
      const j = (i + 1) % xy.length;
      a += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
    }
    return Math.abs(a) / 2;
  }

  function pointInPolygon(p, poly) {
    p = P(p);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = P(poly[i]), b = P(poly[j]);
      if ((a.lat > p.lat) !== (b.lat > p.lat) &&
          p.lng < (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
    }
    return inside;
  }

  // 점 p 에서 선분 ab 까지의 거리(m)
  function pointToSegment(p, a, b) {
    p = P(p); a = P(a); b = P(b);
    const A = toXY(a, p), B = toXY(b, p); // p 를 원점으로
    const dx = B.x - A.x, dy = B.y - A.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : -(A.x * dx + A.y * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = A.x + t * dx, cy = A.y + t * dy;
    return Math.sqrt(cx * cx + cy * cy);
  }

  function centroid(pts) {
    let lat = 0, lng = 0;
    for (const q of pts) { const p = P(q); lat += p.lat; lng += p.lng; }
    return { lat: lat / pts.length, lng: lng / pts.length };
  }

  function bbox(pts) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const q of pts) { const p = P(q); s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
    return { s, n, w, e };
  }

  // 미터를 위도/경도 차이로 (대략)
  function mToLat(m) { return m / 110540; }
  function mToLng(m, lat) { return m / (Math.cos(rad(lat)) * 111320); }

  function pathLength(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
    return l;
  }

  // 간단한 공간 격자 인덱스 (약 20m 셀). 다른 팀원의 궤적 점을 빠르게 찾기 위함.
  class Grid {
    constructor(cell = 0.0002) { this.cell = cell; this.m = new Map(); }
    key(lat, lng) { return Math.floor(lat / this.cell) + '_' + Math.floor(lng / this.cell); }
    add(p, payload) {
      const k = this.key(p.lat, p.lng);
      let arr = this.m.get(k); if (!arr) { arr = []; this.m.set(k, arr); }
      arr.push(payload);
    }
    near(p) {
      const la = Math.floor(p.lat / this.cell), lo = Math.floor(p.lng / this.cell);
      const out = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const arr = this.m.get((la + i) + '_' + (lo + j)); if (arr) out.push(...arr);
      }
      return out;
    }
    clear() { this.m.clear(); }
  }

  return { dist, toXY, polygonAreaM2, pointInPolygon, pointToSegment, centroid, bbox, mToLat, mToLng, pathLength, Grid };
})();
