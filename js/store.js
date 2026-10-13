/* localStorage 기반 저장. 오프라인 우선: 모든 상태는 먼저 이 기기에 저장되고, 통신이 되면 공유된다. */
window.Store = (() => {
  const NS = 'fm.';
  function get(key, def) {
    try { const v = localStorage.getItem(NS + key); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function set(key, val) {
    try { localStorage.setItem(NS + key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('store.set failed', e); return false; }
  }
  function del(key) { try { localStorage.removeItem(NS + key); } catch (e) { /* ignore */ } }

  // 세션 하나의 저장 단위: zones, markers, tracks(내 것만 영속), coverage
  function loadSession(code) {
    return get('session.' + code, null) || { code, zones: [], markers: [], tracks: {}, coverage: {}, created: Date.now() };
  }
  let saveTimer = null;
  function saveSession(sess) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => set('session.' + sess.code, sess), 400);
  }
  function saveSessionNow(sess) { clearTimeout(saveTimer); set('session.' + sess.code, sess); }
  function listSessions() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS + 'session.')) out.push(k.slice((NS + 'session.').length));
    }
    return out.sort();
  }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  return { get, set, del, loadSession, saveSession, saveSessionNow, listSessions, uid };
})();
