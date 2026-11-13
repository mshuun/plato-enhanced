const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('settings expose only calendar integration and save without a submitter or login messages', async () => {
  const dom = new JSDOM(read('options.html'), { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  let settings = { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 };
  w.PlatoCalendarExt = { nespaSettings: { get: async () => settings, save: async patch => { settings = { ...settings, ...patch }; return settings; } } };
  try {
    w.eval(read('options.js')); await tick();
    assert.equal(w.document.querySelector('input[type="password"],#auto-login,#credentials-form,#retry-login'), null);
    w.document.getElementById('course-url').value = 'https://emerald.pusan.ac.kr/ds2027/';
    w.document.getElementById('course-name').value = '새 강좌';
    w.document.getElementById('course-year').value = '2027';
    w.document.getElementById('settings-form').requestSubmit(); await tick();
    assert.equal(settings.courseName, '새 강좌');
    assert.equal(Object.hasOwn(settings, 'autoLogin'), false);
    assert.equal(w.document.getElementById('nespa-login-link').href, 'https://emerald.pusan.ac.kr/ds2027/login/');
    assert.match(w.document.getElementById('status').textContent, /저장/);
    assert.equal(w.document.querySelector('button[type="submit"]').disabled, false);
  } finally { w.close(); }
});

test('options lock the editable form during initial load and save, and reject duplicate submissions', async () => {
  const dom = new JSDOM(read('options.html'), { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
  const w = dom.window, settings = { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 };
  let loaded, saved, calls = 0;
  w.PlatoCalendarExt = { nespaSettings: {
    get: () => new Promise(resolve => { loaded = resolve; }),
    save: () => { calls++; return new Promise(resolve => { saved = resolve; }); }
  } };
  try {
    w.eval(read('options.js'));
    const form = w.document.getElementById('settings-form');
    assert.ok([...form.elements].every(control => control.disabled));
    assert.equal(form.getAttribute('aria-busy'), 'true');
    loaded(settings); await tick();
    assert.ok([...form.elements].every(control => !control.disabled));
    form.requestSubmit();
    assert.ok([...form.elements].every(control => control.disabled));
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(calls, 1);
    saved(settings); await tick();
    assert.equal(form.getAttribute('aria-busy'), 'false');
    assert.ok([...form.elements].every(control => !control.disabled));
    assert.match(w.document.getElementById('status').textContent, /저장했습니다/);
  } finally { loaded?.(settings); saved?.(settings); await tick(); w.close(); }
});

test('failed option saves preserve the draft, unlock inputs and allow a retry', async () => {
  const dom = new JSDOM(read('options.html'), { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  const settings = { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 };
  let fail = true;
  w.PlatoCalendarExt = { nespaSettings: { get: async () => settings, save: async patch => { if (fail) throw new Error('저장 공간 오류'); return { ...settings, ...patch }; } } };
  try {
    w.eval(read('options.js')); await tick();
    const form = w.document.getElementById('settings-form'), name = w.document.getElementById('course-name');
    name.value = '입력 중인 강좌';
    form.requestSubmit(); await tick();
    assert.equal(name.value, '입력 중인 강좌');
    assert.ok([...form.elements].every(control => !control.disabled));
    assert.equal(form.getAttribute('aria-busy'), 'false');
    assert.match(w.document.getElementById('status').textContent, /저장 공간 오류/);
    fail = false; form.requestSubmit(); await tick();
    assert.equal(name.value, '입력 중인 강좌');
    assert.match(w.document.getElementById('status').textContent, /저장했습니다/);
  } finally { w.close(); }
});

async function connectedOptions({ failLoad = false, initialLoad = null } = {}) {
  const dom = new JSDOM(read('options.html'), { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  const h = { w, listeners: new Set(), calls: [], settings: { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 } };
  let initial = initialLoad;
  h.read = async () => { if (failLoad) throw new Error('읽기 실패'); if (initial) { const pending = initial; initial = null; return pending; } return { ...h.settings }; };
  h.write = async patch => { h.settings = { ...h.settings, ...patch }; return { ...h.settings }; };
  h.external = patch => { h.settings = { ...h.settings, ...patch }; for (const listener of h.listeners) listener({ ...h.settings }); };
  w.PlatoCalendarExt = { nespaSettings: { get: () => h.read(), save: (patch, expected) => {
    h.calls.push(JSON.parse(JSON.stringify({ patch, expected }))); return h.write(patch, expected);
  }, subscribe(listener) { h.listeners.add(listener); return () => h.listeners.delete(listener); } } };
  h.submit = () => w.document.querySelector('#settings-form').requestSubmit();
  h.close = () => { w.dispatchEvent(new w.PageTransitionEvent('pagehide', { persisted: false })); w.close(); };
  w.eval(read('options.js')); await tick();
  return h;
}

test('other option windows update untouched controls and only edited fields are submitted', async () => {
  const h = await connectedOptions(), doc = h.w.document;
  try {
    h.external({ courseName: '다른 창에서 저장한 강좌명' });
    assert.equal(doc.querySelector('#course-name').value, '다른 창에서 저장한 강좌명');
    doc.querySelector('#enabled').checked = false;
    h.submit(); await tick();
    assert.deepEqual(h.calls[0].patch, { enabled: false });
    assert.equal(h.calls[0].expected.courseName, '다른 창에서 저장한 강좌명');
    assert.equal(h.settings.courseName, '다른 창에서 저장한 강좌명');
    assert.equal(h.settings.enabled, false);
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide', { persisted: false }));
    assert.equal(h.listeners.size, 0);
  } finally { h.close(); }
});

test('external changes preserve raw drafts and disclose conflicting saved values', async () => {
  const h = await connectedOptions(), doc = h.w.document;
  try {
    doc.querySelector('#course-name').value = '작성 중인 강좌명';
    doc.querySelector('#course-url').value = 'https://';
    doc.querySelector('#course-year').value = '';
    h.external({ courseName: '다른 창의 강좌명', courseUrl: 'https://emerald.pusan.ac.kr/ds2027/', courseYear: 2027, enabled: false });
    assert.equal(doc.querySelector('#course-name').value, '작성 중인 강좌명');
    assert.equal(doc.querySelector('#course-url').value, 'https://');
    assert.equal(doc.querySelector('#course-year').value, '');
    assert.equal(doc.querySelector('#enabled').checked, false);
    assert.equal(doc.querySelector('#nespa-login-link').href, 'https://emerald.pusan.ac.kr/ds2027/login/');
    assert.match(doc.querySelector('#status').textContent, /다른 창의 강좌명/);
    assert.match(doc.querySelector('#status').textContent, /현재 입력/);
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('a settings conflict keeps the draft and allows a reviewed retry against the new baseline', async () => {
  const h = await connectedOptions(), doc = h.w.document;
  try {
    doc.querySelector('#course-name').value = '내가 입력한 강좌명';
    h.write = async () => {
      h.settings = { ...h.settings, courseName: '먼저 저장한 강좌명' };
      throw Object.assign(new Error('conflict'), { code: 'NESPA_SETTINGS_CONFLICT', settings: { ...h.settings } });
    };
    h.submit(); await tick();
    assert.equal(doc.querySelector('#course-name').value, '내가 입력한 강좌명');
    assert.equal(h.settings.courseName, '먼저 저장한 강좌명');
    assert.match(doc.querySelector('#status').textContent, /먼저 저장한 강좌명/);
    assert.equal(doc.querySelector('button[type="submit"]').disabled, false);
    h.write = async patch => (h.settings = { ...h.settings, ...patch });
    h.submit(); await tick();
    assert.equal(h.calls[1].expected.courseName, '먼저 저장한 강좌명');
    assert.equal(h.settings.courseName, '내가 입력한 강좌명');
  } finally { h.close(); }
});

test('an external change during an acknowledged save is read again before unlocking the form', async () => {
  const h = await connectedOptions(), doc = h.w.document;
  let finish;
  try {
    h.write = patch => {
      h.settings = { ...h.settings, ...patch };
      const written = { ...h.settings };
      return new Promise(resolve => { finish = () => resolve(written); });
    };
    doc.querySelector('#course-name').value = '저장한 강좌명';
    h.submit();
    h.external({ enabled: false, courseYear: 2027 });
    assert.equal(doc.querySelector('button[type="submit"]').disabled, true);
    finish(); await tick();
    assert.equal(doc.querySelector('#course-name').value, '저장한 강좌명');
    assert.equal(doc.querySelector('#enabled').checked, false);
    assert.equal(doc.querySelector('#course-year').value, '2027');
    assert.equal(doc.querySelector('#settings-form').getAttribute('aria-busy'), 'false');
  } finally { finish?.(); h.close(); }
});

test('a failed initial read cannot save defaults over settings that were never loaded', async () => {
  const h = await connectedOptions({ failLoad: true }), doc = h.w.document;
  try {
    doc.querySelector('#course-url').value = 'https://emerald.pusan.ac.kr/ds2026/';
    doc.querySelector('#course-name').value = '입력 중';
    doc.querySelector('#course-year').value = '2026';
    h.submit(); await tick();
    assert.equal(h.calls.length, 0);
    assert.match(doc.querySelector('#status').textContent, /저장된 설정을 확인하지 못했습니다/);
    assert.equal(doc.querySelector('#course-name').value, '입력 중');
  } finally { h.close(); }
});

test('initial loading catches up to an external change before enabling edits', async () => {
  let finish;
  const initialLoad = new Promise(resolve => { finish = resolve; });
  const h = await connectedOptions({ initialLoad }), doc = h.w.document;
  try {
    const original = { ...h.settings };
    h.external({ courseName: '새로 저장한 강좌', courseYear: 2027 });
    finish(original); await tick();
    assert.equal(doc.querySelector('#course-name').value, '새로 저장한 강좌');
    assert.equal(doc.querySelector('#course-year').value, '2027');
    assert.equal(doc.querySelector('#settings-form').getAttribute('aria-busy'), 'false');
  } finally { finish(h.settings); h.close(); }
});

test('unrelated external settings do not rewrite unchanged raw text in a focused input', async () => {
  const h = await connectedOptions(), doc = h.w.document;
  try {
    const name = doc.querySelector('#course-name');
    name.value = ' 자료구조 '; name.focus(); name.setSelectionRange(2, 3);
    h.external({ enabled: false });
    assert.equal(name.value, ' 자료구조 ');
    assert.equal(name.selectionStart, 2);
    assert.equal(name.selectionEnd, 3);
    assert.equal(doc.activeElement, name);
    assert.equal(doc.querySelector('#enabled').checked, false);
  } finally { h.close(); }
});

test('a valid external update recovers an initial read failure without replacing a typed draft', async () => {
  const h = await connectedOptions({ failLoad: true }), doc = h.w.document;
  try {
    doc.querySelector('#course-name').value = '내가 작성 중인 강좌명';
    h.external({ courseYear: 2027, courseName: '다른 창에서 저장한 강좌명' });
    assert.equal(doc.querySelector('#course-name').value, '내가 작성 중인 강좌명');
    assert.equal(doc.querySelector('#course-year').value, '2027');
    assert.equal(doc.querySelector('#course-url').value, h.settings.courseUrl);
    assert.match(doc.querySelector('#status').textContent, /다른 창에서 저장한 강좌명/);
    h.submit(); await tick();
    assert.deepEqual(h.calls[0].patch, { courseName: '내가 작성 중인 강좌명' });
  } finally { h.close(); }
});
