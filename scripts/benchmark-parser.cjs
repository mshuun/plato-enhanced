'use strict';
// A repeatable synthetic matching benchmark; browser integration is tested separately.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const baselinePath = process.env.PLATO_BENCHMARK_BASELINE || path.join(root, 'plato-enhanced-1.6.14.zip');
const baseline = JSON.parse(execFileSync('python', ['-c',
  'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); files={"source":"src/plato-parser.js","model":"src/calendar-model.js","view":"src/calendar-view.js","modal":"src/activity-modal.js","optionsCss":"styles/options.css","optionsHtml":"options.html"}; print(json.dumps({"version":json.loads(z.read("manifest.json"))["version"],**{k:z.read(v).decode("utf-8") for k,v in files.items()}}))', baselinePath], { encoding: 'utf8' }));
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const current = fs.readFileSync(path.join(root, 'src/plato-parser.js'), 'utf8');
const deadline = Date.parse('2026-11-15T22:00:00+09:00') / 1000;
const dom = new JSDOM('');
function payload(eventCount, actionCount, exact) {
  const item = id => ({ id, name: 'Task ' + id, modulename: 'assign', course: { id: 9, fullname: 'Course' },
    timestart: deadline, url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=' + id });
  return { month: { events: Array.from({ length: eventCount }, (_, i) => item(i + 1)) },
    action: { events: Array.from({ length: actionCount }, (_, i) => item(exact ? actionCount - i : 10000 + i)) } };
}
function run(source, input, operation = 'month') {
  let urlConstructions = 0, domParses = 0;
  class MeasuredURL extends URL { constructor(...args) { super(...args); urlConstructions++; } }
  class MeasuredDOMParser extends dom.window.DOMParser {
    parseFromString(...args) { domParses++; return super.parseFromString(...args); }
  }
  const context = vm.createContext({ URL: MeasuredURL, DOMParser: MeasuredDOMParser });
  vm.runInContext(source, context);
  const started = performance.now();
  let activities;
  try {
    activities = operation === 'month' ? context.PlatoCalendarExt.parser.normalizeMonthPayload(input) :
      context.PlatoCalendarExt.parser.mergeDetail(input.activity, input.detail);
  } catch (error) {
    if (operation === 'month') throw error;
    activities = { error: error.message };
  }
  const elapsedMs = performance.now() - started;
  const serialized = JSON.stringify(activities);
  return { elapsedMs: Math.round(elapsedMs * 100) / 100, urlConstructions, domParses, activities: activities.length,
    outputHash: crypto.createHash('sha256').update(serialized).digest('hex') };
}
const cases = [];
for (const [events, actions, exact] of [[40, 80, false], [100, 200, false], [200, 400, false], [100, 200, true]]) {
  const input = payload(events, actions, exact);
  const before = run(baseline.source, input), after = run(current, input);
  assert.equal(after.outputHash, before.outputHash, 'matching results must remain identical');
  cases.push({ events, actions, exact, baseline: before, current: after });
}
const seed = 0x51a7;
let randomState = seed;
const pick = values => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return values[randomState % values.length]; };
for (let sample = 0; sample < 64; sample++) {
  const item = index => ({ id: pick([index + 1, String(index + 1), index % 5 + 1, null]),
    name: pick(['Mixed ' + index, `<b>Mixed ${index}</b>`, 'A &amp; B', 'Line\nText', 'Literal > end', 'nul\0end']),
    modulename: pick(['assign', 'quiz', 'QUIZ', null]), course: pick([null, { id: 9 }, { id: 10 }]),
    instance: pick([null, 0, undefined, 1, 2, 3]), timestart: pick([deadline, deadline + 3600, undefined]),
    timesort: pick([undefined, 'unavailable', deadline, deadline + 3600]), submitted: pick([undefined, true, false]),
    url: pick(['https://plato.pusan.ac.kr/calendar/view.php?view=day',
      `https://plato.pusan.ac.kr/mod/assign/view.php?id=${index % 9 + 1}`,
      `https://plato.pusan.ac.kr/mod/quiz/view.php?id=${index % 9 + 1}`]) });
  const input = { month: { events: Array.from({ length: 12 }, (_, i) => item(i)) },
    action: { events: Array.from({ length: 24 }, (_, i) => item(i)) } };
  if (sample % 2) input.action.events.push(input.action.events[0]);
  const before = run(baseline.source, input), after = run(current, input);
  if (before.outputHash !== after.outputHash) {
    fs.writeFileSync(path.join(root, 'artifacts', 'parser-benchmark-failure.json'), JSON.stringify({ sample, input, before, after }, null, 2));
    throw new Error('Parser differential mismatch at sample ' + sample);
  }
}
let detailSamples = 0;
for (const activityUrl of ['/mod/assign/view.php?id=7', 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7',
  '/calendar/view.php?view=day', 'https://user:pass@plato.pusan.ac.kr/mod/assign/view.php?id=7']) {
  for (const url of [undefined, '/calendar/view.php?view=day', '/mod/assign/view.php?id=7', '/mod/quiz/view.php?id=7',
    '/mod/assign/view.php?id=8', '/mod/assign/view.php?id=7&id=8']) {
    const input = { activity: { id: 'calendar:1', eventId: 1, courseName: 'Course', title: 'Original', typeCode: 'assign',
      typeLabel: '과제', activityUrl, deadline, description: null, sourceStatus: { code: 'unknown' }, submissionStatus: null },
      detail: { event: { id: 1, url, name: 'Fresh &amp; decoded', modulename: 'QUIZ', course: { fullname: 'Fresh course' } } } };
    assert.equal(run(current, input, 'detail').outputHash, run(baseline.source, input, 'detail').outputHash);
    detailSamples++;
  }
}

function formatRun(source, timezone) {
  let constructions = 0;
  const measuredIntl = { DateTimeFormat: new Proxy(Intl.DateTimeFormat, { construct(target, args) {
    constructions++; return Reflect.construct(target, args);
  } }) };
  class FixedDate extends Date { static now() { return deadline * 1000; } }
  const context = vm.createContext({ Intl: measuredIntl, Date: FixedDate });
  vm.runInContext(source, context);
  const model = context.PlatoCalendarExt.calendarModel;
  const legacy = !model.formatTime || !model.formatDeadline;
  if (legacy) {
    for (const [code, name, next] of [[baseline.view, 'formatTime', 'CalendarView'], [baseline.modal, 'formatDeadline', 'ActivityModal']]) {
      const start = code.indexOf('  function ' + name + '('), end = code.indexOf('\n  class ' + next, start);
      assert.ok(start >= 0 && end > start, 'baseline must contain the original formatting function');
      vm.runInContext('globalThis.' + name + ' = (' + code.slice(start, end).trim() + ');', context);
    }
  }
  const time = legacy ? context.formatTime : model.formatTime;
  const full = legacy ? context.formatDeadline : model.formatDeadline;
  const input = Array.from({ length: 200 }, (_, i) => ({ id: i, deadline: deadline + i * 600 }));
  const started = performance.now();
  const grid = model.getMonthGrid(2026, 11, timezone);
  const groups = [...model.groupActivitiesByDay(input, timezone)];
  const labels = input.map(item => {
    const label = time(item.deadline, timezone);
    return [label, legacy ? time(item.deadline, timezone) : label, full(item.deadline, timezone)];
  });
  return { formatterConstructions: constructions, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    outputHash: crypto.createHash('sha256').update(JSON.stringify({ grid, groups, labels })).digest('hex') };
}
const calendarCases = ['Asia/Seoul', 'UTC', 'America/New_York', 'Invalid/Timezone'].map(timezone => {
  const before = formatRun(baseline.model, timezone);
  const after = formatRun(fs.readFileSync(path.join(root, 'src/calendar-model.js'), 'utf8'), timezone);
  assert.equal(after.outputHash, before.outputHash, 'date display and grouping must remain identical');
  return { timezone, baseline: before, current: after };
});

function optionStyles(css) {
  const page = new JSDOM(baseline.optionsHtml), doc = page.window.document;
  const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  const properties = ['display', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'padding',
    'border', 'borderRadius', 'gap', 'gridTemplateColumns', 'flexDirection', 'alignItems', 'justifyContent', 'opacity', 'whiteSpace'];
  const states = [];
  for (const state of ['normal', 'error', 'disabled']) {
    doc.querySelector('#status').classList.toggle('error', state === 'error');
    doc.querySelector('button').disabled = state === 'disabled';
    states.push([...doc.querySelectorAll('main, main *')].map(node => {
      const value = page.window.getComputedStyle(node);
      return properties.map(property => value[property]);
    }));
  }
  page.window.close(); return states;
}
const baselineStyles = optionStyles(baseline.optionsCss);
assert.deepEqual(optionStyles(fs.readFileSync(path.join(root, 'styles/options.css'), 'utf8')), baselineStyles);
const result = { baselineArchive: path.basename(baselinePath), baselineVersion: baseline.version, currentVersion,
  scope: 'Synthetic Node VM/JSDOM runs without networking; operation counts and identical output are primary evidence, timings are diagnostic.',
  differential: { seed, samples: 64, detailSamples, equalOutputs: true }, cases, calendarCases,
  optionsStyles: { elements: baselineStyles[0].length, states: baselineStyles.length, equalComputedStyles: true } };
fs.writeFileSync(path.join(root, 'artifacts', 'parser-benchmark.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
dom.window.close();
