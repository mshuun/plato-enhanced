(function initNespaBackground(global) {
  'use strict';
  const api = global.PlatoCalendarExt.nespaSettings;
  const pendingReads = new Map();
  const activeReads = new Set();
  let generation = 0;
  let sessionEpoch = 0;
  const loginMessage = 'NESPA에서 직접 로그인한 뒤 PLATO 달력을 새로고침해 주세요.';
  const changed = () => ({ ok: false, error: 'disabled', message: 'NESPA 달력 연동 설정이 변경되었습니다.' });
  const authRequired = () => ({ ok: false, error: 'auth-required', message: loginMessage });
  function invalidateReads() {
    pendingReads.clear();
    for (const controller of activeReads) controller.abort();
  }

  function resourceUrl(settings, message) {
    if (message.resource === 'assignments') return settings.courseUrl + 'assignment_list/';
    if (message.resource === 'detail' && /^[0-9]{1,40}$/.test(String(message.problemId || ''))) {
      return settings.courseUrl + 'submission_detail/?prob_id=' + String(message.problemId);
    }
    throw new Error('지원하지 않는 NESPA 조회입니다.');
  }

  async function readPage(url, settings) {
    const controller = new AbortController();
    activeReads.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal });
      const final = new URL(response.url);
      if (!final.href.startsWith(settings.courseUrl)) throw new Error('NESPA 응답 주소를 확인할 수 없습니다.');
      if (response.status === 401 || response.status === 403) return authRequired();
      if (!response.ok) throw new Error('NESPA 과제 정보를 가져오지 못했습니다.');
      const html = await response.text();
      if (html.length > 3000000) throw new Error('NESPA 응답이 너무 큽니다.');
      if (/\/login\/?$/.test(final.pathname) || /id\s*=\s*["']sidebar_login["']/i.test(html) || /로그인이\s*필요한\s*기능/.test(html)) {
        return authRequired();
      }
      const requested = new URL(url);
      if (final.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '') || final.search !== requested.search) {
        throw new Error('NESPA 과제 응답 주소가 변경되었습니다.');
      }
      return { ok: true, html, finalUrl: final.href, fetchedAt: Date.now() };
    } finally { clearTimeout(timeout); activeReads.delete(controller); }
  }

  async function fetchResource(message) {
    const started = generation;
    const session = sessionEpoch;
    const settings = await api.get();
    if (started !== generation) return changed();
    if (session !== sessionEpoch) return authRequired();
    if (!settings.enabled) return { ok: false, error: 'disabled', message: 'NESPA 달력 연동이 꺼져 있습니다.' };
    const url = resourceUrl(settings, message);
    if (pendingReads.has(url)) return pendingReads.get(url);
    const promise = (async () => {
      try {
        const result = await readPage(url, settings);
        const current = await api.get();
        if (started !== generation || !current.enabled || current.courseUrl !== settings.courseUrl) return changed();
        if (session !== sessionEpoch) return authRequired();
        if (result.error === 'auth-required') {
          // A recovered caller must not join a read from the expired session.
          sessionEpoch += 1;
          invalidateReads();
        }
        return result;
      } catch (error) {
        if (started !== generation) return changed();
        if (session !== sessionEpoch) return authRequired();
        throw error;
      }
    })().finally(() => { if (pendingReads.get(url) === promise) pendingReads.delete(url); });
    pendingReads.set(url, promise);
    return promise;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'PE_NESPA_FETCH' || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
    let source;
    try { source = new URL(sender.url); } catch (_) { return false; }
    if (source.origin !== 'https://plato.pusan.ac.kr' || !['/', '/index.php'].includes(source.pathname)) return false;
    fetchResource(message).then(respond, error => respond({ ok: false, error: 'error', message: error.message || 'NESPA에 연결하지 못했습니다.' }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[api.KEY]) return;
    generation += 1;
    invalidateReads();
  });
})(globalThis);
