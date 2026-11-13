const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const origin = 'https://plato.pusan.ac.kr';
const deadline = Date.parse('2026-11-15T22:00:00+09:00') / 1000;
const event = (id, url, extra = {}) => ({ id, name: `Activity ${id}`, modulename: 'assign', timestart: deadline,
  course: { id: 9, fullname: 'Example course' }, url, ...extra });

function harness() {
  const dom = new JSDOM('', { url: origin + '/', runScripts: 'outside-only' });
  for (const file of ['config.js', 'plato-parser.js', 'submission-parser.js', 'data-source.js']) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  }
  return { w: dom.window, ns: dom.window.PlatoCalendarExt, close: () => dom.window.close() };
}

test('calendar links and status keys reject embedded credentials', () => {
  const h = harness();
  try {
    for (const url of [origin.replace('https://', 'https://user:pass@') + '/mod/assign/view.php?id=7',
      origin.replace('https://', 'https://user@') + '/calendar/view.php?view=day']) {
      assert.equal(h.ns.parser.safePlatoUrl(url), null);
      assert.equal(h.ns.submissionParser.assignmentUrl(url), null);
      assert.equal(h.ns.submissionParser.activityKey(url), null);
    }
  } finally { h.close(); }
});

test('ambiguous native activity IDs never become a different automatic status request', async () => {
  const h = harness(), source = new h.ns.PlatoDataSource(), calls = [];
  source.request = async () => ({ userId: '42' });
  h.w.fetch = async url => { calls.push(url); throw new Error('must not fetch'); };
  try {
    await source.getContext();
    for (const query of ['id=7&id=8', 'id=7&id=7', 'id=0', 'id=-1', 'id=1e3', 'id=', 'userid=7']) {
      const url = origin + '/mod/assign/view.php?' + query;
      assert.equal(h.ns.submissionParser.assignmentUrl(url), null, query);
      assert.equal(h.ns.submissionParser.activityKey(url), null, query);
      assert.equal(await source.getSubmission({ activityUrl: url }), null, query);
    }
    assert.equal(calls.length, 0);
    assert.equal(h.ns.submissionParser.assignmentUrl(origin + '/mod/assign/view.php?id=7&userid=99&action=edit'), origin + '/mod/assign/view.php?id=7');
  } finally { source.destroy(); h.close(); }
});

test('a malformed native link leaves the scheduled activity readable without navigation', () => {
  const h = harness();
  try {
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [
      event(1, origin + '/mod/assign/view.php?id=7&id=8'),
      event(2, origin + '/mod/assign/view.php?id=9')
    ] } });
    assert.equal(result.length, 2);
    const invalid = result.find(item => item.eventId === 1);
    assert.equal(invalid.title, 'Activity 1');
    assert.equal(invalid.deadline, deadline);
    assert.equal(invalid.activityUrl, null);
    assert.equal(result.find(item => item.eventId === 2).activityUrl, origin + '/mod/assign/view.php?id=9');
  } finally { h.close(); }
});

test('different activities sharing a generic calendar link cannot erase one another', () => {
  const h = harness();
  try {
    const url = origin + '/calendar/view.php?view=day&time=' + deadline;
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, url), event(2, url), event(1, url)] } });
    assert.deepEqual(Array.from(result, item => item.id), ['calendar:1', 'calendar:2']);
  } finally { h.close(); }
});

test('the valid native activity route selects the month type when metadata is stale', () => {
  const h = harness();
  try {
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, origin + '/mod/assign/view.php?id=7', { modulename: 'quiz' })] },
      action: { events: [event(2, origin + '/mod/assign/view.php?id=7', { modulename: 'QUIZ', submitted: true })] } });
    assert.equal(result[0].typeCode, 'assign');
    assert.equal(result[0].typeLabel, '과제');
    assert.equal(result[0].submissionStatus, '제출 완료');
  } finally { h.close(); }
});

test('detail metadata cannot relabel a valid assignment link as another activity type', () => {
  const h = harness();
  try {
    const activity = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, origin + '/mod/assign/view.php?id=7')] } })[0];
    const result = h.ns.parser.mergeDetail(activity, { event: { id: 1, modulename: 'QUIZ', description: 'Fresh details' } });
    assert.equal(result.typeCode, 'assign');
    assert.equal(result.typeLabel, '과제');
    assert.equal(result.description, 'Fresh details');
  } finally { h.close(); }
});

test('a detail response for another calendar event or module cannot replace the selected activity', () => {
  const h = harness();
  try {
    const activity = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, origin + '/mod/assign/view.php?id=7')] } })[0];
    for (const id of [1, 2]) {
      assert.throws(() => h.ns.parser.mergeDetail(activity, { event: event(id, origin + '/mod/assign/view.php?id=9') }), /DETAIL.*MISMATCH/);
    }
    assert.throws(() => h.ns.parser.mergeDetail(activity, { event: { id: [1], description: 'Wrong identity shape' } }), /DETAIL.*MISMATCH/);
    assert.equal(activity.activityUrl, origin + '/mod/assign/view.php?id=7');
  } finally { h.close(); }
});

test('a missing detail for a known event is reported without disabling metadata-only activities', () => {
  const h = harness();
  try {
    const activity = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, origin + '/mod/assign/view.php?id=7')] } })[0];
    for (const payload of [null, { event: null }, [], { event: [] }]) {
      assert.throws(() => h.ns.parser.mergeDetail(activity, payload), /DETAIL.*UNAVAILABLE/);
    }
    const metadataOnly = { ...activity, eventId: null };
    assert.equal(h.ns.parser.mergeDetail(metadataOnly, null).activityUrl, metadataOnly.activityUrl);
  } finally { h.close(); }
});

test('an action with a conflicting native identity cannot change the selected deadline or status', () => {
  const h = harness();
  try {
    const selected = event(1, origin + '/mod/assign/view.php?id=7', { instance: 17 });
    for (const action of [event(1, origin + '/mod/assign/view.php?id=99', { instance: 17, timesort: deadline + 86400, submitted: true }),
      event(1, origin + '/mod/assign/view.php?id=7', { course: { id: 99 }, instance: 17, timesort: deadline + 86400, submitted: true })]) {
      const result = h.ns.parser.normalizeMonthPayload({ month: { events: [selected] }, action: { events: [action] } });
      assert.equal(result[0].deadline, deadline);
      assert.equal(result[0].submissionStatus, null);
    }
  } finally { h.close(); }
});

test('fallback action matching uses the valid deadline when a preferred timestamp is malformed', () => {
  const h = harness();
  try {
    const selected = event(1, origin + '/mod/assign/view.php?id=7', { timesort: 'unavailable' });
    const wrongDate = event(2, origin + '/mod/assign/view.php?id=7', { timesort: deadline + 86400, submitted: true });
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [selected] }, action: { events: [wrongDate] } });
    assert.equal(result[0].deadline, deadline);
    assert.equal(result[0].submissionStatus, null);
  } finally { h.close(); }
});

test('missing instance IDs are never evidence that unrelated activities match', () => {
  const h = harness();
  try {
    for (const instance of [null, 0, '', undefined]) {
      const selected = event(1, origin + '/calendar/view.php?view=day', { instance });
      const unrelated = event(2, origin + '/mod/assign/view.php?id=99', { instance, submitted: true });
      const result = h.ns.parser.normalizeMonthPayload({ month: { events: [selected] }, action: { events: [unrelated] } });
      assert.equal(result[0].activityUrl, selected.url);
      assert.equal(result[0].submissionStatus, null);
    }
  } finally { h.close(); }
});

test('malformed calendar IDs keep the valid native activity identity without becoming another event number', () => {
  const h = harness();
  try {
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [
      event([1], origin + '/mod/assign/view.php?id=7'), event(true, origin + '/mod/assign/view.php?id=8'),
      event('0003', origin + '/mod/assign/view.php?id=9')
    ] } });
    assert.equal(result.length, 3);
    const byModule = id => result.find(item => item.activityUrl === origin + '/mod/assign/view.php?id=' + id);
    assert.equal(byModule(7).eventId, null);
    assert.equal(byModule(8).eventId, null);
    assert.equal(byModule(9).eventId, 3);
    assert.equal(byModule(7).id, 'activity:9:assign:7');
    assert.equal(byModule(8).id, 'activity:9:assign:8');
  } finally { h.close(); }
});

test('a wrapped or boolean timestamp is not a deadline, while numeric timestamps remain supported', () => {
  const h = harness();
  try {
    for (const value of [[deadline], true, { valueOf: () => deadline }]) assert.equal(h.ns.parser.asUnixSeconds(value), null);
    assert.equal(h.ns.parser.asUnixSeconds(deadline), deadline);
    assert.equal(h.ns.parser.asUnixSeconds(String(deadline)), deadline);
    assert.equal(h.ns.parser.asUnixSeconds(deadline * 1000), deadline);
  } finally { h.close(); }
});

test('out-of-range timestamps cannot replace a real calendar or detail deadline', () => {
  const h = harness(), parser = h.ns.parser;
  try {
    for (const value of [Number.MAX_VALUE, 1e100, '1e100', 8640000000000001]) {
      assert.equal(parser.asUnixSeconds(value), null);
      const selected = event(1, origin + '/mod/assign/view.php?id=7', { timesort: value });
      const activity = parser.normalizeMonthPayload({ month: { events: [selected] } })[0];
      assert.equal(activity.deadline, deadline, 'invalid preferred time must fall back to the usable start time');
      assert.equal(parser.mergeDetail(activity, { event: { id: 1, timesort: value } }).deadline, deadline);
      const withoutFallback = { ...selected, timestart: value };
      assert.equal(parser.normalizeMonthPayload({ month: { events: [withoutFallback, event(2, origin + '/mod/assign/view.php?id=8')] } }).length, 1);
    }
  } finally { h.close(); }
});

test('plain text optimization preserves entity decoding, markup, whitespace and null-character handling', () => {
  const h = harness();
  try {
    for (const [value, expected] of [['Plain > text\nnext', 'Plain > text next'], ['A &amp; B', 'A & B'],
      ['<b>Bold</b> &lt;text&gt;', 'Bold <text>'], ['before\0after', 'beforeafter']]) {
      const activity = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, origin + '/mod/assign/view.php?id=7', { name: value, description: value })] } })[0];
      assert.equal(activity.title, expected); assert.equal(activity.description, expected);
    }
  } finally { h.close(); }
});

test('an exact event match keeps priority over an earlier compatible fallback', () => {
  const h = harness();
  try {
    const url = origin + '/mod/assign/view.php?id=7';
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, url)] }, action: { events: [
      event(90, url, { submitted: true }), event(1, url, { submitted: false, timesort: deadline + 3600 })
    ] } });
    assert.equal(result[0].submissionStatus, '미제출');
    assert.equal(result[0].deadline, deadline + 3600);
  } finally { h.close(); }
});

test('fallback instance and native-link candidates preserve their source order and optional metadata', () => {
  const h = harness();
  try {
    const url = origin + '/mod/assign/view.php?id=7';
    const byInstance = event(90, origin + '/calendar/view.php?view=day', { instance: 17, submitted: false, course: null, timestart: null });
    const byLink = event(91, url, { submitted: true });
    for (const [actions, expected] of [[[byInstance, byLink], '미제출'], [[byLink, byInstance], '제출 완료']]) {
      const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, url, { instance: 17 })] }, action: { events: actions } });
      assert.equal(result[0].submissionStatus, expected);
      assert.equal(result[0].deadline, deadline);
    }
  } finally { h.close(); }
});

test('duplicate event IDs retain a later compatible action after a conflicting one', () => {
  const h = harness();
  try {
    const url = origin + '/mod/assign/view.php?id=7';
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, url)] }, action: { events: [
      event(1, origin + '/mod/assign/view.php?id=99', { submitted: true }), event(1, url, { submitted: false })
    ] } });
    assert.equal(result[0].submissionStatus, '미제출');
  } finally { h.close(); }
});

test('fallback matching continues past an incompatible deadline to the matching activity', () => {
  const h = harness();
  try {
    const url = origin + '/mod/assign/view.php?id=7';
    const result = h.ns.parser.normalizeMonthPayload({ month: { events: [event(1, url)] }, action: { events: [
      event(90, url, { submitted: false, timesort: deadline + 86400 }), event(91, url, { submitted: true })
    ] } });
    assert.equal(result[0].submissionStatus, '제출 완료');
    assert.equal(result[0].deadline, deadline);
  } finally { h.close(); }
});

test('normalization neither mutates shared payloads nor reuses another call\'s matching metadata', () => {
  const h = harness();
  try {
    const url = origin + '/mod/assign/view.php?id=7';
    const action = event(1, url, { submitted: true });
    const payload = { month: { events: [event(1, url)] }, action: { events: [action] } };
    const original = JSON.stringify(payload);
    assert.equal(h.ns.parser.normalizeMonthPayload(payload)[0].submissionStatus, '제출 완료');
    assert.equal(JSON.stringify(payload), original);
    action.url = origin + '/mod/assign/view.php?id=99';
    assert.equal(h.ns.parser.normalizeMonthPayload(payload)[0].submissionStatus, null);
  } finally { h.close(); }
});
