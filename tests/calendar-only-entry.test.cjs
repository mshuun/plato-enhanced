"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

test("manifest entry renders NESPA calendar tasks without changing PLATO menus, including old workspace URLs", async t => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.content_scripts.every(entry => entry.matches.every(pattern => pattern.startsWith('https://plato.pusan.ac.kr/'))));
  assert.equal(manifest.web_accessible_resources, undefined);
  const entries = manifest.content_scripts.filter(entry => entry.world === "ISOLATED" && entry.matches.includes("https://plato.pusan.ac.kr/*"));
  assert.equal(entries.length, 1);
  assert.ok(entries[0].js.includes("src/combined-data-source.js"));
  assert.ok(entries[0].js.includes("src/nespa-data-source.js"));
  assert.ok(entries[0].js.includes("src/calendar-view.js"));
  assert.ok(!entries[0].js.some(file => /(?:navigation|workspace|nespa-ui|nespa-board)\.js$/.test(file)));
  assert.ok(!entries[0].css.some(file => /(?:navigation|nespa)/.test(file)));

  for (const hash of ["", "#pe-nespa", "#pe-nespa/notice", "#pe-nespa/course"]) {
    await t.test(hash || "home", async () => {
      const dom = new JSDOM(`<!doctype html><body id="page-site-index">
        <nav id="pw-nav-channel"><div class="moremenu"><ul><li class="active"><a href="/" aria-current="page">홈</a></li><li class="nav-menu-Curriculum"><a href="/local/ubion/allcourse/regular/index.php">교과과정</a></li></ul></div></nav>
        <aside id="pw-nav-menu"><div class="logo">University logo</div><div class="menu-container"><input value="native search"></div></aside>
        <header class="breadcrumb-container">홈</header>
        <main><input id="draft" value="native draft"><div class="dashboard-container"><section class="ongoing-courses">내 강좌</section></div></main>
      </body>`, { url: "https://plato.pusan.ac.kr/" + hash, runScripts: "outside-only", pretendToBeVisual: true });
      const w = dom.window;
      try {
        w.Date.now = () => Date.parse("2026-10-30T12:00:00+09:00");
        const values = {};
        const listeners = new Set();
        const requests = [];
        w.chrome = {
          storage: {
            local: {
              get(key, callback) { const result = typeof key === "string" ? { [key]: values[key] } : { ...values }; callback?.(result); return Promise.resolve(result); },
              set(patch, callback) { Object.assign(values, patch); callback?.(); return Promise.resolve(); }
            },
            onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } }
          },
          runtime: { async sendMessage(message, callback) {
            requests.push(message);
            if (message.type !== "PE_NESPA_FETCH") { const result = { ok: false }; callback?.(result); return result; }
            const html = read("tests/fixtures/" + (message.resource === "detail" ? "nespa-submission-empty.html" : "nespa-assignments.html"));
            const result = { ok: true, html, fetchedAt: w.Date.now() };
            callback?.(result);
            return result;
          } }
        };
        w.document.addEventListener("plato-calendar-ext:request:v1", event => {
          const message = JSON.parse(event.detail);
          const context = { userId: "42", timezone: "Asia/Seoul" };
          const payload = message.operation === "context" ? context : { context, month: {}, action: { complete: true } };
          w.document.dispatchEvent(new w.CustomEvent("plato-calendar-ext:response:v1", { detail: JSON.stringify({ requestId: message.requestId, ok: true, payload }) }));
        });
        const native = ["#pw-nav-channel", "#pw-nav-menu", ".breadcrumb-container"].map(selector => w.document.querySelector(selector));
        const original = native.map(node => node.outerHTML);
        const draft = w.document.getElementById("draft");
        draft.value = "unsaved text";
        for (const file of entries[0].js) w.eval(read(file));
        w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
        for (let attempt = 0; attempt < 100 && !w.document.querySelector('[data-activity-id="activity:nespa:ds2026:13"]'); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const task = w.document.querySelector('[data-activity-id="activity:nespa:ds2026:13"]');
        assert.ok(task, "NESPA task must render through the manifest calendar entry");
        assert.deepEqual(native.map(node => node.outerHTML), original);
        assert.ok(native.every(node => node.isConnected && !node.closest("[hidden]")));
        assert.equal(draft.value, "unsaved text");
        assert.equal(w.document.getElementById("draft"), draft);
        assert.equal(w.document.querySelector("#pe-navigation-nespa,#pe-navigation-settings,#pe-nespa-workspace,.pe-nespa-rail"), null);
        assert.equal(w.document.body.classList.contains("pe-nespa-enabled"), false);
        assert.ok(requests.some(message => message.type === "PE_NESPA_FETCH" && message.resource === "assignments"));
        assert.ok(!requests.some(message => message.type.startsWith("PE_PORTAL_") || message.resource?.startsWith("board-")));
        task.click();
        for (let attempt = 0; attempt < 100 && !w.document.querySelector('.plato-calendar-ext-modal a[href*="submission_detail/"]'); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        const links = [...w.document.querySelectorAll('a[href*="emerald.pusan.ac.kr"]')];
        assert.ok(links.some(link => link.href.endsWith("submission_detail/?prob_id=13")), "calendar detail must keep the native NESPA link");
        await new Promise(resolve => setImmediate(resolve));
        w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(resolve => setImmediate(resolve));
      } finally { w.close(); }
    });
  }
});
