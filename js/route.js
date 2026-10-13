/* 구역 안의 길을 모두 한 번씩 지나는 최단 경로 (우편배달부 문제, 출발점 고정·도착점 자유).
 *
 * 입력: 길 선분(segs), 출발점, 아직 안 돈 선분 집합(required). 출력: 좌표열 + 회전 안내.
 * 방법 (휴리스틱, Frederickson 식 Rural Postman):
 *  1. 선분 끝점을 노드로 그래프를 만든다 (지리원 중심선은 교차점에서 좌표가 같으므로 0.1m 반올림으로 합쳐진다).
 *  2. 돌아야 할 선분들이 여러 덩어리로 떨어져 있으면, 출발점에서 가까운 덩어리부터 최단경로로 잇는다 (이동만 하는 길).
 *  3. 홀수 차수 노드(막다른 골목·T자)를 최단경로 거리로 짝지어 그 경로를 한 번 더 걷게 한다 (greedy + 2-opt 개선).
 *     출발점은 짝에서 빼고, 도착점은 전체 중복이 가장 적어지는 홀수 노드로 고른다.
 *  4. Hierholzer 로 한붓그리기 순서를 뽑는다.
 *  5. 연속 직진을 합쳐 좌/우/유턴 안내로 만든다.
 */
window.Route = (() => {
  // 지리원 중심선은 교차로에서 선이 만나기만 하고 꼭짓점을 공유하지 않는다. 선분끼리의 교차점·T자 접점(1.5m 이내)을 찾아 거기서 쪼갠다.
  function splitAtIntersections(segs, extraCuts) {
    if (!segs.length) return [];
    const ref = segs[0].a; const TOL = 1.5;
    const S = segs.map(s => { const A = Geo.toXY(s.a, ref), B = Geo.toXY(s.b, ref); return { s, A, B, minx: Math.min(A.x, B.x) - TOL, maxx: Math.max(A.x, B.x) + TOL, miny: Math.min(A.y, B.y) - TOL, maxy: Math.max(A.y, B.y) + TOL, cuts: (extraCuts && extraCuts.get(s.key)) ? extraCuts.get(s.key).slice() : [] }; });
    const proj = (P, A, B) => { const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy; if (!l2) return null; const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / l2; const cx = A.x + t * dx, cy = A.y + t * dy; return { t, d: Math.hypot(P.x - cx, P.y - cy) }; };
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
      const a = S[i], b = S[j];
      if (a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny) continue;
      // 교차
      const r = { x: a.B.x - a.A.x, y: a.B.y - a.A.y }, q = { x: b.B.x - b.A.x, y: b.B.y - b.A.y };
      const den = r.x * q.y - r.y * q.x;
      if (Math.abs(den) > 1e-9) {
        const w = { x: b.A.x - a.A.x, y: b.A.y - a.A.y };
        const t = (w.x * q.y - w.y * q.x) / den, u = (w.x * r.y - w.y * r.x) / den;
        if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) { a.cuts.push(t); b.cuts.push(u); continue; }
      }
      // T자: 한쪽 끝점이 상대 선분 위(1.5m 이내)에 닿음
      for (const P of [a.A, a.B]) { const p = proj(P, b.A, b.B); if (p && p.d <= TOL && p.t > 0.02 && p.t < 0.98) b.cuts.push(p.t); }
      for (const P of [b.A, b.B]) { const p = proj(P, a.A, a.B); if (p && p.d <= TOL && p.t > 0.02 && p.t < 0.98) a.cuts.push(p.t); }
    }
    const out = [];
    for (const e of S) {
      const ts = [0].concat(e.cuts.sort((x, y) => x - y)).concat([1]);
      let prev = 0;
      for (let k = 1; k < ts.length; k++) {
        const t = ts[k]; if (t - prev < 0.005 && k < ts.length - 1) continue;
        const pa = [e.s.a[0] + (e.s.b[0] - e.s.a[0]) * prev, e.s.a[1] + (e.s.b[1] - e.s.a[1]) * prev];
        const pb = [e.s.a[0] + (e.s.b[0] - e.s.a[0]) * t, e.s.a[1] + (e.s.b[1] - e.s.a[1]) * t];
        out.push({ key: e.s.key, a: pa, b: pb, len: e.s.len * (t - prev) });
        prev = t;
      }
    }
    return out;
  }
  // 막다른 끝점이 12m 이내의 다른 길에 닿아 있으면(T자 교차로에서 작은 길의 중심선이 큰 길 가장자리에서 끝나는 지리원 데이터 특성) 연결 선분을 넣는다.
  // 연결 선분은 '이동용'일 뿐 돌아야 할 길이 아니다 (key 가 link: 로 시작).
  function addConnectors(segsIn) {
    const g0 = buildRaw(segsIn, null, []);
    const extraCuts = new Map(); const links = [];
    const nearEnd = (p, s) => Geo.dist(p, s.a) < 0.5 || Geo.dist(p, s.b) < 0.5;
    const dead = g0.nodes.filter(n => n.adj.length === 1);
    const GAP = 12;
    dead.forEach((n, ni) => {
      // (1) 12m 이내의 가장 가까운 다른 길에 잇는다 (T자)
      let best = null, bd = GAP;
      for (const s of segsIn) {
        if (nearEnd(n.p, s)) continue;
        if (Math.abs(s.a[0] - n.p[0]) > 0.0003 || Math.abs(s.a[1] - n.p[1]) > 0.0004) continue;
        const d = Geo.pointToSegment(n.p, s.a, s.b);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) {
        const A = Geo.toXY(best.a, n.p), B = Geo.toXY(best.b, n.p);   // n.p 원점
        const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
        let t = l2 ? -(A.x * dx + A.y * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const q = [best.a[0] + (best.b[0] - best.a[0]) * t, best.a[1] + (best.b[1] - best.a[1]) * t];
        if (t > 0.03 && t < 0.97) { if (!extraCuts.has(best.key)) extraCuts.set(best.key, []); extraCuts.get(best.key).push(t); }
        links.push({ key: 'link:' + links.length, a: n.p, b: q, len: Math.max(0.5, bd) });
      }
      // (2) 12m 이내의 다른 막다른 끝점 전부와 잇는다 (십자 교차로: 네 팔이 교차로 네모 가장자리에서 끊겨 있다)
      for (let mj = ni + 1; mj < dead.length; mj++) { const m = dead[mj]; const d = Geo.dist(n.p, m.p); if (d > 0.5 && d < GAP) links.push({ key: 'link:' + links.length, a: n.p, b: m.p, len: d }); }
    });
    return { extraCuts, links };
  }
  function buildRaw(segsIn, extraCuts, links) {
    const segs = splitAtIntersections(segsIn, extraCuts).concat(links);
    const nodes = [], idx = new Map();
    const key = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);
    const nodeOf = p => { const k = key(p); let i = idx.get(k); if (i == null) { i = nodes.length; idx.set(k, i); nodes.push({ p, adj: [] }); } return i; };
    const edges = segs.map((s, ei) => { const a = nodeOf(s.a), b = nodeOf(s.b); const e = { id: ei, a, b, len: s.len, key: s.key }; nodes[a].adj.push(e); nodes[b].adj.push(e); return e; });
    // 1.5m 이내의 끝점은 같은 교차점으로 본다 (타일 경계·수치 오차)
    const grid = new Map(); const cell = p => Math.floor(p[0] / 0.00002) + '_' + Math.floor(p[1] / 0.00002);
    const parent = nodes.map((_, i) => i); const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    nodes.forEach((n, i) => {
      const [cy, cx] = [Math.floor(n.p[0] / 0.00002), Math.floor(n.p[1] / 0.00002)];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const arr = grid.get((cy + dy) + '_' + (cx + dx)); if (arr) for (const j of arr) if (Geo.dist(n.p, nodes[j].p) < 1.5) parent[find(i)] = find(j); }
      const k = cell(n.p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    });
    for (const e of edges) { e.a = find(e.a); e.b = find(e.b); }
    nodes.forEach(n => n.adj = []);
    for (const e of edges) if (e.a !== e.b) { nodes[e.a].adj.push(e); nodes[e.b].adj.push(e); }
    return { nodes, edges: edges.filter(e => e.a !== e.b) };
  }
  function buildGraph(segsIn) { const { extraCuts, links } = addConnectors(segsIn); const g = buildRaw(segsIn, extraCuts, links); g.links = links.length; return g; }
  const other = (e, v) => e.a === v ? e.b : e.a;

  function dijkstra(g, srcs) {
    const dist = new Float64Array(g.nodes.length).fill(Infinity), prev = new Int32Array(g.nodes.length).fill(-1);
    const heap = [];
    const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const s of srcs) { dist[s] = 0; push(0, s); }
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue;
      for (const e of g.nodes[v].adj) { const w = other(e, v), nd = d + e.len; if (nd < dist[w]) { dist[w] = nd; prev[w] = e.id; push(nd, w); } }
    }
    return { dist, prev };
  }
  function pathEdges(g, prev, v) { const out = []; while (prev[v] >= 0) { const e = g.edges.find(x => x.id === prev[v]) || g.edgesById[prev[v]]; out.push(e); v = other(e, v); } return out.reverse(); }

  // 홀수 노드 짝짓기: 탐욕 + 2-opt
  function matchCost(D, odd) {
    if (odd.length < 2) return { cost: 0, pairs: [] };
    const pairs = []; const free = new Set(odd);
    const all = [];
    for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++) all.push([D[odd[i]][odd[j]], odd[i], odd[j]]);
    all.sort((x, y) => x[0] - y[0]);
    for (const [d, a, b] of all) { if (free.has(a) && free.has(b)) { pairs.push([a, b]); free.delete(a); free.delete(b); } if (!free.size) break; }
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
        const [a, b] = pairs[i], [c, d] = pairs[j]; const cur = D[a][b] + D[c][d];
        if (D[a][c] + D[b][d] < cur - 0.01) { pairs[i] = [a, c]; pairs[j] = [b, d]; improved = true; }
        else if (D[a][d] + D[b][c] < cur - 0.01) { pairs[i] = [a, d]; pairs[j] = [b, c]; improved = true; }
      }
    }
    return { cost: pairs.reduce((s, [a, b]) => s + D[a][b], 0), pairs };
  }

  // plan(segs, start, requiredKeys, end?, k?)
  //   end 가 있으면 도착점 고정(집결지), 없으면 도착점 자유. k ≥ 2 면 같은 출발점에서 k 명이 나눠 돌고 집결지에 모이는 경로 k 개.
  function plan(segs, start, requiredKeys, end, k) {
    k = Math.max(1, k | 0 || 1);
    const g = buildGraph(segs);
    g.edgesById = {}; for (const e of g.edges) g.edgesById[e.id] = e;
    if (!g.edges.length) return null;
    const R = g.edges.filter(e => !e.key.startsWith('link:') && (!requiredKeys || requiredKeys.has(e.key)));
    if (!R.length) return null;
    // 출발 노드: 돌아야 할 길이 가장 많은 덩어리(전체 그래프 기준) 안에서 출발점에 가장 가까운 노드.
    // 구역 가장자리의 고립된 토막에 출발점이 붙으면 경로가 거기서 끝나 버리기 때문.
    const fc = new Int32Array(g.nodes.length).fill(-1); const fcLen = [];
    for (let i = 0; i < g.nodes.length; i++) if (fc[i] < 0 && g.nodes[i].adj.length) { const id = fcLen.length; fcLen.push(0); const st = [i]; fc[i] = id; while (st.length) { const v = st.pop(); for (const e of g.nodes[v].adj) { if (fc[e.a] === id && fc[e.b] === id) continue; const w = other(e, v); if (fc[w] < 0) { fc[w] = id; st.push(w); } } } }
    for (const e of R) if (fc[e.a] >= 0) fcLen[fc[e.a]] += e.len;
    let mainC = 0; fcLen.forEach((l, i) => { if (l > fcLen[mainC]) mainC = i; });
    let s = 0, sd = Infinity; g.nodes.forEach((n, i) => { if (!n.adj.length || fc[i] !== mainC) return; const d = Geo.dist(start, n.p); if (d < sd) { sd = d; s = i; } });
    let e = null;
    if (end) { let ed = Infinity; g.nodes.forEach((n, i) => { if (!n.adj.length || fc[i] !== mainC) return; const d = Geo.dist(end, n.p); if (d < ed) { ed = d; e = i; } }); }

    // 멀티그래프 M: 돌아야 할 선분 + 이동용 중복 선분
    const M = []; const deg = new Int32Array(g.nodes.length);
    const addM = (e, extra) => { M.push({ e, extra }); deg[e.a]++; deg[e.b]++; };
    for (const e of R) addM(e, false);

    // 떨어진 덩어리 잇기: 출발점 집합에서 가장 가까운 미연결 덩어리까지 최단경로를 추가
    const comp = new Int32Array(g.nodes.length).fill(-1); let nc = 0;
    { const adjR = g.nodes.map(() => []); for (const e of R) { adjR[e.a].push(e); adjR[e.b].push(e); }
      for (let i = 0; i < g.nodes.length; i++) if (comp[i] < 0 && adjR[i].length) { const st = [i]; comp[i] = nc; while (st.length) { const v = st.pop(); for (const e of adjR[v]) { const w = other(e, v); if (comp[w] < 0) { comp[w] = nc; st.push(w); } } } nc++; } }
    const connected = new Set(); if (comp[s] >= 0) connected.add(comp[s]);
    let guard = 0;
    while (connected.size < nc && guard++ < nc + 2) {
      const srcs = []; for (let i = 0; i < g.nodes.length; i++) if (i === s || (comp[i] >= 0 && connected.has(comp[i]))) srcs.push(i);
      const { dist, prev } = dijkstra(g, srcs);
      let best = -1, bd = Infinity;
      for (let i = 0; i < g.nodes.length; i++) if (comp[i] >= 0 && !connected.has(comp[i]) && dist[i] < bd) { bd = dist[i]; best = i; }
      if (best < 0) break;   // 길이 안 이어짐 (구역이 두 동강)
      for (const e of pathEdges(g, prev, best)) addM(e, true);
      connected.add(comp[best]);
    }

    // 못 이은 덩어리(구역이 두 동강 난 경우)는 경로에서 빠진다 → 알려준다
    let unreachedLen = 0;
    if (connected.size < nc) {
      const M2 = []; let skipped = 0;
      for (const m of M) { if (!m.extra && comp[m.e.a] >= 0 && !connected.has(comp[m.e.a])) { unreachedLen += m.e.len; deg[m.e.a]--; deg[m.e.b]--; skipped++; } else M2.push(m); }
      M.length = 0; M.push(...M2);
    }
    // 집결지가 M 에 안 붙어 있으면(그 자리에 돌 길이 없음) 가장 가까운 M 노드까지 이동 경로를 붙인다
    if (e != null && e !== s && deg[e] === 0) {
      const { dist, prev } = dijkstra(g, [e]); let best = -1, bd = Infinity;
      for (let i = 0; i < g.nodes.length; i++) if (deg[i] > 0 && dist[i] < bd) { bd = dist[i]; best = i; }
      if (best >= 0) for (const ed of pathEdges(g, prev, best)) addM(ed, true);
    }
    // 홀수 노드
    let odd = []; for (let i = 0; i < g.nodes.length; i++) if (deg[i] % 2 === 1) odd.push(i);
    const need = Array.from(new Set(odd.concat([s]).concat(e != null ? [e] : [])));
    const D = {}, P = {};
    for (const v of need) { const r = dijkstra(g, [v]); D[v] = r.dist; P[v] = r.prev; }
    let bestPlan = null;
    const consider = (cost, pairs, extraPaths) => { if (!bestPlan || cost < bestPlan.cost) bestPlan = { cost, pairs, extraPaths }; };
    const sOdd = deg[s] % 2 === 1;
    if (e != null && e !== s) {
      // 도착점 고정: 가상 변 s–e 를 더해 s,e 의 홀짝을 뒤집고 나머지를 전부 짝지은 뒤 가상 변을 빼면 s→e 한붓그리기가 된다
      const set = new Set(odd); for (const v of [s, e]) { if (set.has(v)) set.delete(v); else set.add(v); }
      const m = matchCost(D, Array.from(set)); consider(m.cost, m.pairs, []);
    }
    else if (!odd.length) consider(0, [], []);
    else if (sOdd) {
      for (const t of odd) { if (t === s) continue; const rest = odd.filter(v => v !== s && v !== t); const m = matchCost(D, rest); consider(m.cost, m.pairs, []); }
      if (odd.length === 1) consider(0, [], []);
    } else {
      const mAll = matchCost(D, odd); consider(mAll.cost, mAll.pairs, []);             // 출발점으로 돌아오는 회로
      const near = odd.slice().sort((a, b) => D[s][a] - D[s][b]).slice(0, 5);
      for (const u of near) for (const t of odd) { if (t === u) continue; const rest = odd.filter(v => v !== u && v !== t); const m = matchCost(D, rest); consider(D[s][u] + m.cost, m.pairs, [[s, u]]); }
    }
    for (const [a, b] of bestPlan.pairs) for (const e of pathEdges(g, P[a], b)) addM(e, true);
    for (const [a, b] of bestPlan.extraPaths) for (const e of pathEdges(g, P[a], b)) addM(e, true);

    // Hierholzer
    const adjM = g.nodes.map(() => []); M.forEach((m, i) => { adjM[m.e.a].push(i); adjM[m.e.b].push(i); });
    const used = new Uint8Array(M.length); const ptr = new Int32Array(g.nodes.length);
    const stack = [{ v: s, via: -1 }], order = [];
    while (stack.length) {
      const top = stack[stack.length - 1]; const lst = adjM[top.v];
      while (ptr[top.v] < lst.length && used[lst[ptr[top.v]]]) ptr[top.v]++;
      if (ptr[top.v] < lst.length) { const mi = lst[ptr[top.v]]; used[mi] = 1; stack.push({ v: other(M[mi].e, top.v), via: mi }); }
      else order.push(stack.pop());
    }
    order.reverse();   // order[0].v === s
    const coords = order.map(o => g.nodes[o.v].p);
    let len = 0, extra = 0, covered = 0;
    for (const o of order) if (o.via >= 0) { const m = M[o.via]; len += m.e.len; if (m.extra) extra += m.e.len; else covered += m.e.len; }
    const base = { start: g.nodes[s].p, end: coords[coords.length - 1], unreached: Math.round(unreachedLen), links: g.links, at: Date.now() };
    if (k === 1) return Object.assign(base, { coords, len: Math.round(len), extra: Math.round(extra), covered: Math.round(covered), steps: makeSteps(coords) });

    // ---- k 명 분할 (Frederickson): 한붓그리기를 k 조각으로 자르고, 조각 앞뒤를 출발점·집결지와 최단경로로 잇고, 경계를 움직여 최장 길이를 줄인다 ----
    const eNode = e != null ? e : null;
    const dS = dijkstra(g, [s]); const dE = eNode != null ? dijkstra(g, [eNode]) : null;
    const nodeOrder = order.map(o => o.v);
    const edgeLen = order.map(o => o.via >= 0 ? M[o.via].e.len : 0);      // edgeLen[i] = 꼭짓점 i-1 → i
    const edgeReq = order.map(o => o.via >= 0 && !M[o.via].extra);
    const cum = [0]; for (let i = 1; i < edgeLen.length; i++) cum.push(cum[i - 1] + edgeLen[i]);
    const total = cum[cum.length - 1];
    const n = nodeOrder.length;
    // 경계 b[0]=0 < b[1] < ... < b[k]=n-1 (꼭짓점 인덱스). 조각 j = [b[j], b[j+1]]
    const b = [0]; for (let j = 1; j < k; j++) { const target = total * j / k; let i = 1; while (i < n - 1 && cum[i] < target) i++; b.push(Math.max(b[j - 1] + 1, Math.min(i, n - k + j))); } b.push(n - 1);
    const costOf = (a, c) => dS.dist[nodeOrder[a]] + (cum[c] - cum[a]) + (dE ? dE.dist[nodeOrder[c]] : 0);
    const costs = () => { const out = []; for (let j = 0; j < k; j++) out.push(costOf(b[j], b[j + 1])); return out; };
    for (let it = 0; it < 60; it++) {
      let improved = false;
      for (let j = 1; j < k; j++) {
        const cur = Math.max(costOf(b[j - 1], b[j]), costOf(b[j], b[j + 1]));
        let bestI = b[j], bestV = cur;
        for (let d = -6; d <= 6; d++) { const i = b[j] + d; if (d === 0 || i <= b[j - 1] || i >= b[j + 1]) continue; const v = Math.max(costOf(b[j - 1], i), costOf(i, b[j + 1])); if (v < bestV - 0.01) { bestV = v; bestI = i; } }
        if (bestI !== b[j]) { b[j] = bestI; improved = true; }
      }
      if (!improved) break;
    }
    const nodePath = (prevArr, v) => pathEdges(g, prevArr, v);   // source → v 의 변들
    const routes = [];
    for (let j = 0; j < k; j++) {
      const a = b[j], c = b[j + 1];
      const pts = []; let rlen = 0, rcov = 0;
      // s → 조각 시작
      let v = s; pts.push(g.nodes[s].p);
      for (const ed of nodePath(dS.prev, nodeOrder[a])) { v = other(ed, v); pts.push(g.nodes[v].p); rlen += ed.len; }
      for (let i = a + 1; i <= c; i++) { pts.push(g.nodes[nodeOrder[i]].p); rlen += edgeLen[i]; if (edgeReq[i]) rcov += edgeLen[i]; }
      if (dE) { const edgesBack = nodePath(dE.prev, nodeOrder[c]).reverse(); let w = nodeOrder[c]; for (const ed of edgesBack) { w = other(ed, w); pts.push(g.nodes[w].p); rlen += ed.len; } }
      routes.push({ idx: j, coords: pts, len: Math.round(rlen), covered: Math.round(rcov), extra: Math.round(rlen - rcov), steps: makeSteps(pts), start: g.nodes[s].p, end: pts[pts.length - 1] });
    }
    return Object.assign(base, { k, routes, maxLen: Math.max(...routes.map(r => r.len)), totalLen: routes.reduce((x, r) => x + r.len, 0), singleLen: Math.round(len) });
  }

  // 회전 안내: 연속 직진은 합친다
  function bearing(a, b) { const y = Math.sin((b[1] - a[1]) * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180); const x = Math.cos(a[0] * Math.PI / 180) * Math.sin(b[0] * Math.PI / 180) - Math.sin(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.cos((b[1] - a[1]) * Math.PI / 180); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
  function makeSteps(coords) {
    const steps = [{ type: 'start', i: 0, dist: 0 }];
    let acc = 0;
    for (let i = 1; i < coords.length - 1; i++) {
      acc += Geo.dist(coords[i - 1], coords[i]);
      let d = bearing(coords[i], coords[i + 1]) - bearing(coords[i - 1], coords[i]); d = ((d + 540) % 360) - 180;
      let type = null;
      if (Math.abs(d) > 150) type = 'uturn'; else if (d > 30) type = 'right'; else if (d < -30) type = 'left';
      if (type) { steps[steps.length - 1].dist = Math.round(acc); steps.push({ type, i, dist: 0 }); acc = 0; }
    }
    acc += coords.length > 1 ? Geo.dist(coords[coords.length - 2], coords[coords.length - 1]) : 0;
    steps[steps.length - 1].dist = Math.round(acc);
    steps.push({ type: 'end', i: coords.length - 1, dist: 0 });
    return steps;
  }

  return { plan, buildGraph };
})();
