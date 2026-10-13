/* 실시간 공유 백엔드. 두 구현 모두 같은 인터페이스:
 *   send(msg)            msg = {type, ...}
 *   onMessage(cb)        cb(msg, fromRemote)
 *   close()
 * 메시지 종류:
 *   hello     {me}                      접속 알림. 받은 쪽은 state 로 응답.
 *   state     {from, zones, markers, tracks:{id:[pts]}, coverage}
 *   presence  {member:{id,name,color,lat,lng,acc,t,tracking}}
 *   track     {memberId, points:[{lat,lng,t,acc}]}   궤적 점 묶음 추가
 *   zones     {zones}      전체 교체(마지막 수정 우선 병합은 받는 쪽에서)
 *   markers   {markers}
 *   coverage  {items:{segKey: memberId}}             길 선분을 처음 지나간 사람
 *   passes    {items:{segKey:{memberId:[t,...]}}}    길 선분 통과 시각 (왕복하면 여러 개)
 *   bye       {memberId}
 */
window.Sync = (() => {

  // (1) 같은 기기의 브라우저 탭끼리. 테스트·시연용. 서버 불필요.
  class LocalSync {
    constructor(code) {
      this.ch = new BroadcastChannel('fm-' + code);
      this.cbs = [];
      this.ch.onmessage = ev => this.cbs.forEach(cb => cb(ev.data, true));
    }
    send(msg) { try { this.ch.postMessage(msg); } catch (e) { console.warn(e); } }
    onMessage(cb) { this.cbs.push(cb); }
    close() { this.ch.close(); }
  }

  // (2) Firebase Realtime Database. 팀 전체가 인터넷으로 공유. 무료 플랜으로 충분한 규모.
  // 데이터 구조: sessions/{code}/{members|tracks|zones|markers|coverage}
  class FirebaseSync {
    constructor(code, me, cfg) {
      this.code = code; this.me = me; this.cbs = []; this.ready = false;
      this.load(cfg);
    }
    async load(cfg) {
      if (!window.firebase) {
        await Promise.all([
          loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js'),
          loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js'),
        ]);
      }
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      this.db = firebase.database();
      this.root = this.db.ref('sessions/' + this.code);
      this.ready = true;
      // 접속 끊기면 presence 자동 제거
      this.root.child('members/' + this.me.id).onDisconnect().remove();
      // 구독
      this.root.child('members').on('value', s => {
        const v = s.val() || {};
        for (const id in v) if (id !== this.me.id) this.emit({ type: 'presence', member: v[id] });
      });
      this.root.child('zones').on('value', s => this.emit({ type: 'zones', zones: Object.values(s.val() || {}) }));
      this.root.child('markers').on('value', s => this.emit({ type: 'markers', markers: Object.values(s.val() || {}) }));
      this.root.child('coverage').on('value', s => this.emit({ type: 'coverage', items: s.val() || {} }));
      this.root.child('passes').on('value', s => this.emit({ type: 'passes', items: s.val() || {} }));
      this.root.child('tracks').on('child_added', s => {
        const id = s.key; if (id === this.me.id) return;
        s.ref.on('child_added', b => this.emit({ type: 'track', memberId: id, points: b.val() || [] }));
      });
      this.flushQueue();
    }
    emit(msg) { this.cbs.forEach(cb => cb(msg, true)); }
    send(msg) {
      if (!this.ready) { (this.q = this.q || []).push(msg); return; }
      const r = this.root;
      switch (msg.type) {
        case 'presence': r.child('members/' + msg.member.id).set(msg.member); break;
        case 'track': r.child('tracks/' + msg.memberId).push(msg.points); break;
        case 'zones': { const o = {}; msg.zones.forEach(z => o[z.id] = stripZone(z)); r.child('zones').set(o); break; }
        case 'markers': { const o = {}; msg.markers.forEach(m => o[m.id] = m); r.child('markers').set(o); break; }
        case 'coverage': r.child('coverage').update(msg.items); break;
        case 'passes': { const u = {}; for (const k in msg.items) for (const m in msg.items[k]) u[k.replace(/[.#$\[\]]/g, '_') + '/' + m] = msg.items[k][m]; r.child('passes').update(u); break; }
        case 'bye': r.child('members/' + msg.memberId).remove(); break;
        case 'hello': break; // Firebase 는 구독으로 상태를 받으므로 불필요
      }
    }
    flushQueue() { const q = this.q || []; this.q = null; q.forEach(m => this.send(m)); }
    onMessage(cb) { this.cbs.push(cb); }
    close() { if (this.root) { this.root.off(); this.root.child('tracks').off(); this.root.child('members/' + this.me.id).remove(); } }
  }

  // 길 선분(segs)은 크므로 서버에는 올리지 않고 각자 추정으로 받는다. 추정 요약만 공유.
  function stripZone(z) { const c = Object.assign({}, z); delete c.segs; delete c.blds; delete c.bb; return c; }

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }

  function create(kind, code, me, cfg) {
    if (kind === 'firebase' && cfg) return new FirebaseSync(code, me, cfg);
    return new LocalSync(code);
  }
  return { create, stripZone };
})();
