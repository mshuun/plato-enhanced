(function (global) {
  'use strict';
  if (!['/', '/index.php'].includes(location.pathname) || !document.body?.matches('#page-site-index')) return;
  const ns = global.PlatoCalendarExt, model = ns.classScheduleModel;
  const refreshIntervalMs = ns.config.cacheTtlMs;
  const source = new ns.PlatoDataSource();
  const rootId = 'plato-enhanced-classroom';
  const days = '일월화수목금토';
  let root, body, clock, refresh, note, courses = [], meetings = [], scope = 'default';
  let fingerprint = '', cacheKey = '', updated = 0, attempted = 0, busy = false, error = '', signature = '';
  let refreshTimer, needsRefresh = false, refreshFocus = false;
  const visible = () => Boolean(root?.isConnected && !document.hidden && !root.closest('[hidden]'));
  function canApply(startedFor) {
    if (fingerprint !== startedFor) return false;
    if (!visible()) { needsRefresh = true; return false; }
    return true;
  }
  const node = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  const storageGet = key => new Promise(resolve => chrome.storage.local.get([key], result => {
    const failed = chrome.runtime.lastError;
    resolve(failed ? null : result?.[key]);
  }));
  const storageSet = (key, value) => new Promise(resolve => chrome.storage.local.set({ [key]: value }, () => {
    const failed = chrome.runtime.lastError;
    resolve(!failed);
  }));
  const request = () => new Promise(resolve => chrome.runtime.sendMessage({ type: 'plato-enhanced:timetable' }, result => {
    const failed = chrome.runtime.lastError;
    resolve(failed ? { ok: false } : result || { ok: false });
  }));
  function install() {
    const dashboard = document.querySelector('body#page-site-index .dashboard-container');
    if (!dashboard) return;
    if (!root?.isConnected) {
      // Hide only the home prompt, leaving the site's navigation intact.
      const prompt = dashboard.querySelector(':scope > .dashboard-prompt');
      document.getElementById(rootId)?.remove();
      root = node('section', 'pe-classroom'); root.id = rootId;
      root.setAttribute('aria-labelledby', 'pe-classroom-title');
      const header = node('div', 'pe-classroom-header');
      const heading = node('h2', '', '수업 바로가기'); heading.id = 'pe-classroom-title';
      heading.tabIndex = -1;
      clock = node('span', 'pe-classroom-clock');
      refresh = node('button', 'pe-classroom-refresh', '시간표 새로고침'); refresh.type = 'button';
      refresh.title = '10분마다 자동 갱신 · 클릭하면 지금 갱신';
      refresh.addEventListener('click', () => sync(true));
      header.append(heading, clock, refresh);
      body = node('div', 'pe-classroom-body');
      note = node('p', 'pe-classroom-note'); note.setAttribute('role', 'status');
      note.tabIndex = -1;
      refreshFocus = false;
      root.append(header, body, note);
      if (prompt) { prompt.hidden = true; dashboard.insertBefore(root, prompt); }
      else dashboard.prepend(root);
      signature = '';
    }
    const found = model.readCourses(document);
    const next = found.map(item => `${item.id}:${item.key}`).sort().join(',');
    if (next !== fingerprint) {
      courses = found; fingerprint = next; meetings = []; updated = 0; attempted = 0; cacheKey = ''; signature = '';
      if (!busy) sync(false);
    }
    render();
    tick();
  }
  async function sync(force) {
    if (busy || !courses.length || !visible()) return;
    force = force || needsRefresh;
    const age = Date.now() - Math.max(updated, attempted);
    if (!force && age >= 0 && age < refreshIntervalMs) return;
    needsRefresh = false;
    busy = true; error = ''; render();
    const startedFor = fingerprint;
    try {
      const context = await source.getContext();
      if (!canApply(startedFor)) return;
      const nextScope = /^\d+$/.test(String(context?.userId || '')) ? String(context.userId) : 'default';
      if (nextScope !== scope || updated > Date.now() || Date.now() - updated >= 7 * 86400000) { meetings = []; updated = 0; }
      scope = nextScope;
      if (scope === 'default') throw new Error('identity');
      cacheKey = `platoEnhanced.timetable.v1.${scope}`;
      const cached = await storageGet(cacheKey);
      if (!canApply(startedFor)) return;
      if (cached?.fingerprint === fingerprint && Number.isFinite(cached.updated) &&
          cached.updated >= updated && cached.updated <= Date.now() && Date.now() - cached.updated < 7 * 86400000 && Array.isArray(cached.meetings)) {
        meetings = cached.meetings.filter(item => model.validMeeting(item, courses));
        updated = cached.updated;
      }
      const cachedAge = Date.now() - updated;
      if (!force && updated && cachedAge >= 0 && cachedAge < refreshIntervalMs) return;
      render();
      attempted = Date.now();
      const result = await request();
      if (!canApply(startedFor)) return;
      if (!result.ok || typeof result.html !== 'string') throw new Error('connection');
      const doc = new DOMParser().parseFromString(result.html, 'text/html');
      const parsed = model.parseTimetable(doc);
      if (!parsed.length) throw new Error('connection');
      const connected = model.connect(courses, parsed).filter(item => model.validMeeting(item, courses));
      if (!connected.length) throw new Error('matching');
      meetings = connected; updated = Date.now();
      const saved = await storageSet(cacheKey, { fingerprint, meetings, updated });
      if (!saved) error = '현재 시간표는 표시되지만 저장하지 못했습니다. 다음 접속 때 다시 연결합니다.';
    } catch (err) {
      // Failures from the previous course list must not postpone its replacement.
      if (!canApply(startedFor)) return;
      attempted = Date.now();
      error = err.message === 'identity' ? 'PLATO 로그인 정보를 확인하지 못했습니다. 페이지를 새로고침해 주세요.' :
        err.message === 'matching' ? '시간표와 일치하는 PLATO 과목·분반을 찾지 못했습니다.' :
          '학생지원시스템에 로그인한 뒤 시간표 새로고침을 눌러 주세요.';
    } finally {
      busy = false; signature = ''; render();
      if (fingerprint !== startedFor) sync(false);
      else if (needsRefresh && visible()) sync(true);
      else scheduleRefresh();
    }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!visible()) return;
    const age = Date.now() - Math.max(updated, attempted);
    const remaining = age < 0 ? 0 : refreshIntervalMs - age;
    if (courses.length && (remaining > 0 || age < 0)) refreshTimer = setTimeout(tick, remaining);
  }
  function card(item, active) {
    const course = courses.find(course => course.id === item.courseId);
    const card = node('article', `pe-classroom-card${active ? ' is-current' : ''}`);
    card.dataset.meetingKey = JSON.stringify([item.courseId, item.day, item.start, item.end, item.from, item.to]);
    const info = node('div', 'pe-classroom-info');
    info.append(node('span', 'pe-classroom-badge', active ? '지금 수업 중' : '다음 수업'));
    info.append(node('h3', '', course.title));
    const when = item.date ? `${item.date.slice(5).replace('-', '/')} ` : '';
    info.append(node('p', '', `${when}${days[item.day]}요일 ${model.time(item.start)}–${model.time(item.end)}${item.room ? ` · ${item.room}` : ''}`));
    const link = node('a', 'pe-classroom-enter', active ? '강의실 입장 →' : '강의실 미리 보기 →');
    link.href = course.url; link.setAttribute('aria-label', `${course.title} 강의실로 이동`);
    card.append(info, link); return card;
  }
  function render() {
    if (!root) return;
    const state = model.select(meetings);
    clock.textContent = `${state.date.slice(5).replace('-', '/')} (${days[state.day]}) ${model.time(state.minute)} · 한국 시간`;
    const captureRefresh = busy && document.activeElement === refresh && visible();
    if (captureRefresh) refreshFocus = true;
    const restoreRefresh = !busy && refreshFocus && document.activeElement === note && visible();
    if (!busy) refreshFocus = false;
    refresh.disabled = busy;
    const stamp = JSON.stringify([fingerprint, meetings, busy, error, state.date, state.active, state.upcoming]);
    if (stamp === signature) return;
    signature = stamp;
    const focused = document.activeElement;
    const focus = body.contains(focused) && visible() ? {
      key: focused.closest('.pe-classroom-card')?.dataset.meetingKey,
      href: focused.getAttribute('href'), top: focused.getBoundingClientRect().top
    } : null;
    body.replaceChildren();
    if (state.active.length) state.active.forEach(item => body.append(card(item, true)));
    else if (state.upcoming.length) {
      body.append(node('p', 'pe-classroom-idle', '지금은 수업 시간이 아닙니다.'));
      state.upcoming.forEach(item => body.append(card(item, false)));
    } else body.append(node('p', 'pe-classroom-idle', busy ? '시간표를 확인하고 있습니다…' :
      meetings.length ? '이번 주에 예정된 수업이 없습니다.' : '시간표를 연결해 주세요.'));
    if (error || !meetings.length) {
      const connect = node('a', 'pe-classroom-connect', '학생지원시스템 열기 ↗');
      connect.href = 'https://onestop.pusan.ac.kr/main'; connect.target = '_blank'; connect.rel = 'noopener';
      body.append(connect);
    }
    const missing = courses.length - new Set(meetings.map(item => item.courseId)).size;
    note.textContent = [error, busy ? '시간표 동기화 중…' : '',
      meetings.length && missing > 0 ? `${missing}개 강의의 시간표 미확인` : ''].filter(Boolean).join(' · ');
    if (captureRefresh) note.focus();
    else if (restoreRefresh) refresh.focus();
    else if (focus && [document.body, document.documentElement, focused, null].includes(document.activeElement)) {
      const sameMeeting = [...body.querySelectorAll('.pe-classroom-card')].find(card => card.dataset.meetingKey === focus.key);
      const target = focus.key ? sameMeeting?.querySelector('a[href]') :
        [...body.querySelectorAll('a[href]')].find(link => link.getAttribute('href') === focus.href);
      if (target) {
        target.focus({ preventScroll: true });
        const delta = target.getBoundingClientRect().top - focus.top;
        if (delta) window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
      } else root.querySelector('#pe-classroom-title').focus();
    }
  }
  let pending;
  const observer = new MutationObserver(changes => {
    if (!changes.some(change => !root?.contains(change.target) &&
      !change.target.closest?.('#plato-calendar-ext-root, .plato-calendar-ext-modal-overlay'))) return;
    clearTimeout(pending); pending = setTimeout(install, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pageshow', install);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  function tick() {
    if (!visible()) return;
    render();
    const age = Date.now() - Math.max(updated, attempted);
    if (!busy && courses.length && (needsRefresh || age < 0 || age >= refreshIntervalMs)) sync(needsRefresh);
  }
  setInterval(tick, 30000);
  install();
})(globalThis);
