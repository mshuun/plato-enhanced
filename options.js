(function initOptions() {
  'use strict';
  const api = globalThis.PlatoCalendarExt.nespaSettings;
  const byId = id => document.getElementById(id);
  const form = byId('settings-form');
  const save = form.querySelector('button[type="submit"]');
  const fields = { enabled: '사용 여부', courseUrl: '강좌 주소', courseName: '강좌명', courseYear: '학년도' };
  const controls = { enabled: byId('enabled'), courseUrl: byId('course-url'), courseName: byId('course-name'), courseYear: byId('course-year') };
  let baseline = null, busy = false, pendingExternal = false;
  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.elements) control.disabled = value;
  }
  function status(text, error = false) {
    byId('status').textContent = text;
    byId('status').classList.toggle('error', error);
  }
  function show(settings) {
    byId('enabled').checked = settings.enabled;
    byId('course-url').value = settings.courseUrl;
    byId('course-name').value = settings.courseName;
    byId('course-year').value = settings.courseYear;
    byId('nespa-login-link').href = new URL('login/', settings.courseUrl).href;
  }
  function draft() {
    const url = controls.courseUrl.value.trim();
    return { enabled: controls.enabled.checked, courseUrl: api.canonicalUrl?.(url) || url,
      courseName: controls.courseName.value.trim(), courseYear: Number(controls.courseYear.value) };
  }
  const initialInputs = draft();
  function applyExternal(settings) {
    const previous = baseline || initialInputs;
    const changed = Object.keys(fields).filter(key => settings[key] !== previous[key]);
    if (!changed.length) return;
    const input = draft();
    const dirty = Object.keys(fields).filter(key => input[key] !== previous[key]);
    const conflicts = changed.filter(key => dirty.includes(key) && input[key] !== settings[key]);
    for (const key of changed) {
      if (dirty.includes(key)) continue;
      if (key === 'enabled') controls[key].checked = settings[key];
      else controls[key].value = settings[key];
    }
    baseline = { ...settings };
    byId('nespa-login-link').href = new URL('login/', settings.courseUrl).href;
    const values = conflicts.map(key => `${fields[key]}: ${key === 'enabled' ? settings[key] ? '켜짐' : '꺼짐' : settings[key]}`).join(', ');
    status(conflicts.length ? `다른 창에서 변경한 값은 ${values}입니다. 편집 중인 입력은 유지했습니다. 저장하면 현재 입력을 적용합니다.` :
      dirty.length ? '다른 창의 설정 변경을 반영했습니다. 편집 중인 입력은 유지했습니다.' : '다른 설정 창의 변경을 반영했습니다.', conflicts.length > 0);
  }
  async function drainExternal() {
    while (pendingExternal) {
      pendingExternal = false;
      try { applyExternal(await api.get()); }
      catch (_) { status('다른 창의 설정을 확인하지 못했습니다. 입력은 유지했습니다. 설정 페이지를 새로고침해 주세요.', true); break; }
    }
  }
  const unsubscribe = api.subscribe?.(settings => {
    if (busy) pendingExternal = true;
    else applyExternal(settings);
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) unsubscribe?.(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    if (!baseline) { status('저장된 설정을 확인하지 못했습니다. 설정 페이지를 새로고침한 뒤 저장해 주세요.', true); return; }
    const input = draft();
    const patch = Object.fromEntries(Object.keys(fields).filter(key => input[key] !== baseline[key]).map(key => [key, input[key]]));
    const expected = { ...baseline };
    const focused = document.activeElement;
    setBusy(true);
    status('설정을 저장하고 있습니다…');
    try {
      const settings = await api.save(patch, expected);
      baseline = { ...settings };
      show(settings);
      status(settings.enabled ? '달력 연동 설정을 저장했습니다.' : 'NESPA 달력 연동을 껐습니다.');
    } catch (error) {
      if (error?.code === 'NESPA_SETTINGS_CONFLICT' && error.settings) applyExternal(error.settings);
      else status(error?.message || '설정을 저장하지 못했습니다.', true);
    }
    finally {
      await drainExternal();
      setBusy(false);
      if (document.activeElement === document.body && form.contains(focused)) focused.focus();
    }
  });
  setBusy(true);
  status('설정을 불러오고 있습니다…');
  api.get().then(settings => { baseline = { ...settings }; show(settings); status(''); }).catch(error => status(error?.message || '설정을 불러오지 못했습니다.', true))
    .finally(async () => { await drainExternal(); setBusy(false); });
})();
