"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
function load(w, name) { w.eval(fs.readFileSync(path.join(root, "src", name), "utf8")); }
function window() {
  return new JSDOM("<!doctype html><body><button id='before'>Before</button></body>", { url: "https://plato.pusan.ac.kr/", runScripts: "outside-only" }).window;
}
const deadline = Date.parse("2026-10-31T22:00:00+09:00") / 1000;
const platoItem = { id: "calendar:1", courseId: 13, title: "PLATO", deadline, activityUrl: "https://plato.pusan.ac.kr/mod/assign/view.php?id=1", typeCode: "assign" };
const nespaItem = { id: "activity:nespa:ds2026:13", provider: "nespa", courseId: 13, problemId: "13", title: "NESPA", courseName: "자료구조", deadline, activityUrl: "https://emerald.pusan.ac.kr/ds2026/submission_detail/?prob_id=13", typeCode: "assign" };

test("providers fail independently, deduplicate and filter visible 42-day range", async () => {
  const w = window();
  load(w, "config.js"); load(w, "calendar-model.js");
  const ns = w.PlatoCalendarExt;
  let pFail = false, nFail = false;
  ns.PlatoDataSource = class {
    async getMonth() { if (pFail) throw Error("p"); return { activities: [platoItem, platoItem], userScope: "42", timezone: "Asia/Seoul" }; }
    destroy() {}
  };
  ns.NespaDataSource = class {
    async getActivities() { if (nFail) throw Error("n"); return { activities: [nespaItem, { ...nespaItem, id: "future", deadline: Date.parse("2028-01-01") / 1000 }], state: "ok" }; }
    destroy() {}
  };
  load(w, "combined-data-source.js");
  const source = new ns.CombinedDataSource();
  let result = await source.getMonth(2026, 10, false);
  assert.equal(result.activities.length, 2);
  assert.equal(result.activities.find(item => item.id === platoItem.id).provider, "plato");
  assert.equal(result.userScope, "42");
  nFail = true;
  result = await source.getMonth(2026, 10, true);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].provider, "plato");
  assert.equal(result.partial, true);
  pFail = true; nFail = false;
  result = await source.getMonth(2026, 10, true);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].provider, "nespa");
  assert.equal(result.userScope, "default");
  pFail = nFail = true;
  result = await source.getMonth(2026, 10, true);
  assert.equal(result.activities.length, 0);
  assert.equal(result.providerState.nespa, "error");
  source.destroy(); w.close();
});

test("NESPA unknown status is never labelled unsubmitted or manually completed", () => {
  const w = window(); load(w, "calendar-model.js");
  const classify = w.PlatoCalendarExt.calendarModel.classifyActivity;
  assert.equal(classify(nespaItem, true, deadline - 100, 48).code, "unknown");
  assert.equal(classify({ ...nespaItem, submissionCheck: "failed" }, false, deadline + 100, 48).code, "unknown");
  assert.equal(classify({ ...nespaItem, submissionCheck: "verified", submissionStatus: "미제출" }, false, deadline - 10, 48).code, "due-soon");
  assert.equal(classify({ ...nespaItem, submissionCheck: "verified", submissionStatus: "제출됨", score: 0 }, false, deadline, 48).code, "submitted");
  assert.equal(classify({ ...platoItem, submissionStatus: "제출 완료" }, false, deadline, 48).code, "submitted");
  assert.equal(classify(platoItem, true, deadline, 48).code, "manual");
  w.close();
});

test("NESPA numeric course IDs never reach Moodle completion/detail APIs", async () => {
  const w = window();
  for (const file of ["config.js", "plato-parser.js", "submission-parser.js", "calendar-model.js", "activity-modal.js"]) load(w, file);
  const ns = w.PlatoCalendarExt;
  const calls = [];
  ns.CombinedDataSource = class {
    async getCourseCompletions(id) { calls.push(["course", id]); return null; }
    async getSubmission(item) { calls.push(["submission", item.id]); return null; }
    async getNespaDetail(item) { calls.push(["nespa", item.id]); return { ...item, submissionStatus: "미제출" }; }
    getDetail() { throw Error("NESPA reached Moodle"); }
    updateActivity() {}
    updateActivities() {}
  };
  load(w, "calendar-view.js");
  const view = new ns.CalendarView();
  view.activities = [platoItem, nespaItem];
  view.render = () => {};
  await view.refreshSubmissions(view.loadSequence, true);
  assert.deepEqual(calls, [["course", 13], ["submission", "calendar:1"]]);
  const updated = [];
  view.dataSource.updateActivities = items => updated.push(...items);
  view.applyCourseResult(13, { entries: {}, check: "failed", checkedAt: Date.now() });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, platoItem.id);
  await view.loadActivityDetail(nespaItem);
  assert.equal(calls.at(-1)[0], "nespa");
  assert.equal(await view.toggleManual(nespaItem, true), false);
  view.modal.destroy(); w.close();
});

test("legacy PLATO completion tombstones and collapsed state remain compatible", async () => {
  const w = window();
  const state = { "platoCalendarExt.manualCompletions": { "42": { "calendar:1": true } } };
  w.chrome = { runtime: {}, storage: { local: {
    get(keys, cb) { cb({ ...state }); }, set(values, cb) { Object.assign(state, values); cb(); }
  }, onChanged: { addListener() {}, removeListener() {} } } };
  load(w, "config.js"); load(w, "storage.js");
  const storage = w.PlatoCalendarExt.storage;
  assert.equal((await storage.getManualCompletions("42"))["calendar:1"], true);
  await storage.setManualCompletion("42", "calendar:1", false);
  assert.equal((await storage.getManualCompletions("42"))["calendar:1"], undefined);
  assert.equal(state["platoCalendarExt.manualCompletions.v2.42.calendar:1"], false);
  await storage.setCollapsed(true);
  assert.equal(await storage.getCollapsed(), true);
  w.close();
});

test('manual completion acknowledges a successful write independently of an unrelated storage read failure', async () => {
  const w = window(), stored = {};
  w.chrome = { runtime: {}, storage: { local: {
    get() { throw new Error('READ_OFFLINE'); }, set(values, callback) { Object.assign(stored, values); callback(); }
  } } };
  try {
    load(w, 'config.js'); load(w, 'storage.js');
    await w.PlatoCalendarExt.storage.setManualCompletion('42', 'calendar:1', true);
    assert.equal(stored['platoCalendarExt.manualCompletions.v2.42.calendar:1'], true);
    await assert.rejects(w.PlatoCalendarExt.storage.getManualCompletions('42'), /READ_OFFLINE/);
  } finally { w.close(); }
});
