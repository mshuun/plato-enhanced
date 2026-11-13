(function initNespaSettings(global) {
  'use strict';
  const ns = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const KEY = 'platoEnhanced.nespa.settings';
  const DEFAULTS = Object.freeze({ enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 });
  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://emerald.pusan.ac.kr' || url.username || url.password || url.search || url.hash || !/^\/[a-zA-Z0-9_-]{1,60}\/?$/.test(url.pathname)) return null;
      return `${url.origin}${url.pathname.replace(/\/$/, '')}/`;
    } catch (_) { return null; }
  }
  function normalize(value) {
    const item = value && typeof value === 'object' ? value : {};
    const year = Number(item.courseYear);
    return {
      enabled: typeof item.enabled === 'boolean' ? item.enabled : DEFAULTS.enabled,
      courseUrl: canonicalUrl(item.courseUrl) || DEFAULTS.courseUrl,
      courseName: typeof item.courseName === 'string' && item.courseName.trim() ? item.courseName.trim().slice(0, 60) : DEFAULTS.courseName,
      courseYear: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : DEFAULTS.courseYear
    };
  }
  async function get() { return normalize((await chrome.storage.local.get(KEY))[KEY]); }
  let writes = Promise.resolve();
  function writeLocked(task) {
    if (global.navigator?.locks?.request) return global.navigator.locks.request(KEY, task);
    // Runtime extension pages must coordinate with every other extension context.
    if (global.location?.protocol === 'chrome-extension:') return Promise.reject(new Error('설정 저장 기능을 사용할 수 없습니다. 확장 설정 페이지를 새로고침해 주세요.'));
    // Standalone previews and non-browser test environments have no shared origin.
    const next = writes.then(task);
    writes = next.catch(() => {});
    return next;
  }
  async function save(patch, expected = null) {
    patch = { ...patch };
    expected = expected && { ...expected };
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled') && typeof patch.enabled !== 'boolean') throw new Error('NESPA 달력 연동 사용 여부를 확인해 주세요.');
    if (Object.prototype.hasOwnProperty.call(patch, 'courseUrl') && !canonicalUrl(patch.courseUrl)) throw new Error('NESPA 강좌 주소를 확인해 주세요. 예: https://emerald.pusan.ac.kr/ds2026/');
    if (Object.prototype.hasOwnProperty.call(patch, 'courseName') &&
        (typeof patch.courseName !== 'string' || !patch.courseName.trim() || patch.courseName.trim().length > 60)) throw new Error('강좌명을 1~60자로 입력해 주세요.');
    if (Object.prototype.hasOwnProperty.call(patch, 'courseYear') &&
        ((typeof patch.courseYear !== 'number' && typeof patch.courseYear !== 'string') || !String(patch.courseYear).trim() ||
         !Number.isInteger(Number(patch.courseYear)) || Number(patch.courseYear) < 2000 || Number(patch.courseYear) > 2100)) throw new Error('학년도를 2000~2100 사이의 정수로 입력해 주세요.');
    return writeLocked(async () => {
      const current = await get();
      const next = normalize({ ...current, ...patch });
      if (expected && Object.keys(DEFAULTS).some(key => Object.prototype.hasOwnProperty.call(patch, key) &&
          current[key] !== expected[key] && next[key] !== current[key])) {
        throw Object.assign(new Error('다른 설정 창에서 같은 항목을 변경했습니다.'), { code: 'NESPA_SETTINGS_CONFLICT', settings: current });
      }
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    });
  }
  function subscribe(listener) {
    const changed = (changes, area) => { if (area === 'local' && changes[KEY]) listener(normalize(changes[KEY].newValue)); };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }
  ns.nespaSettings = Object.freeze({ KEY, canonicalUrl, get, save, subscribe });
})(globalThis);
