"use strict";
// Anonymous preview only: no installed extension or authenticated browser profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { launch, until: waitUntil } = require('./chromium-harness.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'browser-smoke');
(async () => {
  const session = await launch(output, ['--disable-extensions']);
  const { browser, version: browserVersion, errors: exceptions } = session;
  const checks = [];
  let page;
  const send = (method, params) => page.send(method, params);
  const evaluate = fn => page.evaluate(fn);
  const until = fn => waitUntil(page, fn);
  async function screenshot(name) {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64'));
  }
  async function navigate(name) {
    await send('Page.navigate', { url: pathToFileURL(path.join(root, 'artifacts', 'preview', name)).href });
    await until(() => document.readyState === 'complete');
  }
  async function tab(shift = false) {
    const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }
  try {
    const target = (await session.list()).find(item => item.type === 'page');
    page = await session.connect(target.webSocketDebuggerUrl);
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await navigate('plato.html');
    await until(() => document.body.dataset.previewReady === 'true' && !pePreview.loading && !pePreview.checkingSubmissions);
    const focus = await evaluate(() => {
      const view = pePreview, base = view.activities.find(item => item.provider === 'nespa');
      view.activities = Array.from({ length: 8 }, (_, index) => ({ ...base, id: `activity:nespa:ds2026:${index + 1}`, problemId: String(index + 1), title: `예시 과제 ${index + 1}` }));
      view.render();
      const more = view.root.querySelector('.plato-calendar-ext-more-button');
      more.focus(); more.click();
      const item = view.dayPopover.node.querySelectorAll('[data-activity-id]')[7];
      item.focus();
      const scroll = view.dayPopover.node.scrollTop;
      view.updateActivity({ ...view.activities[7], title: '갱신된 예시 과제 8' });
      return { focused: document.activeElement.dataset.activityId, open: Boolean(view.dayPopover),
        fresh: document.activeElement.textContent.includes('갱신된'), scrollRetained: scroll === view.dayPopover.node.scrollTop,
        controls: view.dayPopover.trigger.getAttribute('aria-controls') === view.dayPopover.node.id };
    });
    assert.deepEqual(focus, { focused: 'activity:nespa:ds2026:8', open: true, fresh: true, scrollRetained: true, controls: true });
    checks.push({ name: 'popover refresh focus and scroll', ...focus });
    await screenshot('calendar-desktop.png');
    await evaluate(() => document.activeElement.click());
    await until(() => !pePreview.modal.detailLoading);
    await evaluate(() => pePreview.modal.openLink.focus());
    await tab();
    assert.equal(await evaluate(() => document.activeElement === pePreview.modal.closeButton), true);
    await tab(true);
    assert.equal(await evaluate(() => document.activeElement === pePreview.modal.openLink), true);
    await screenshot('detail-desktop.png');
    await evaluate(() => pePreview.modal.close());
    assert.equal(await evaluate(() => document.activeElement.dataset.activityId), 'activity:nespa:ds2026:8');
    checks.push({ name: 'native Tab and Shift+Tab dialog trap and overflow return', passed: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await until(() => pePreview.dayPopover.node.getBoundingClientRect().width < pePreview.content.clientWidth);
    const visibility = await evaluate(() => {
      const card = document.activeElement.getBoundingClientRect(), area = pePreview.content.getBoundingClientRect();
      return { left: card.left, right: card.right, areaLeft: area.left, areaRight: area.right, popupWidth: pePreview.dayPopover.node.getBoundingClientRect().width };
    });
    assert.ok(visibility.left >= visibility.areaLeft && visibility.right <= visibility.areaRight, JSON.stringify(visibility));
    checks.push({ name: 'mobile overflow activity focus stays visible', ...visibility });
    await screenshot('calendar-mobile.png');
    const mobile = await evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(mobile.scrollWidth <= mobile.width, JSON.stringify(mobile));
    checks.push({ name: 'mobile page overflow', ...mobile });
    const expired = await evaluate(async () => {
      pePreviewSession = false;
      pePreview.activities = pePreview.activities.map(item => ({ ...item, submissionStatus: '제출됨', submissionCheck: 'verified', score: 100, attempts: 3 }));
      await pePreview.modal.open(pePreview.activities[7], false);
      return { cleared: pePreview.activities.every(item => item.score === null && item.attempts === null && item.submissionStatus === '확인 필요'),
        dialogCleared: pePreview.modal.activity.score === null && !pePreview.modal.body.textContent.includes('최고 채점점수'),
        loginHint: pePreview.modal.feedback.textContent.includes('직접 로그인') };
    });
    assert.deepEqual(expired, { cleared: true, dialogCleared: true, loginHint: true });
    checks.push({ name: 'observed expiry clears the calendar and open detail', ...expired });
    await screenshot('detail-mobile-expired.png');
    const footerFits = await evaluate(() => {
      const dialog = pePreview.modal.dialog.getBoundingClientRect();
      return [...pePreview.modal.footer.querySelectorAll('a,button')].filter(node => node.getClientRects().length)
        .every(node => { const rect = node.getBoundingClientRect(); return rect.left >= dialog.left && rect.right <= dialog.right; });
    });
    assert.equal(footerFits, true, 'all mobile detail actions must remain inside the dialog');
    await navigate('options.html');
    await until(() => document.querySelector('#settings-form')?.getAttribute('aria-busy') === 'false');
    const busy = await evaluate(async () => {
      const original = chrome.storage.local.set;
      chrome.storage.local.set = values => new Promise(resolve => { globalThis.finishPreviewSave = () => resolve(original(values)); });
      document.querySelector('#course-name').value = '브라우저 검증 강좌';
      document.querySelector('#settings-form').requestSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));
      return [...document.querySelector('#settings-form').elements].every(control => control.disabled);
    });
    assert.equal(busy, true);
    await screenshot('options-mobile-saving.png');
    await evaluate(() => finishPreviewSave());
    await until(() => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false');
    assert.equal(await evaluate(() => document.querySelector('#status').textContent.includes('저장했습니다')), true);
    await screenshot('options-mobile.png');
    checks.push({ name: 'options pending write lock and successful recovery', passed: true });
    assert.deepEqual(exceptions, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, browser, browserVersion, checks, exceptions }, null, 2));
    console.log('Chromium UI smoke passed: popover, dialog keyboard, mobile overflow, session expiry and settings; screenshots saved to artifacts/browser-smoke.');
  } catch (error) {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: false, browser, browserVersion, checks, exceptions, error: error.message }, null, 2));
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
