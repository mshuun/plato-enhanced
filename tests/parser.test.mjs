import assert from "node:assert/strict";
import test from "node:test";

globalThis.PlatoCalendarExt = {};
await import("../src/plato-parser.js");

const parser = globalThis.PlatoCalendarExt.parser;

test("normalizes observed assignment and quiz activities from a monthly payload", () => {
  const payload = {
    month: {
      weeks: [
        {
          days: [
            {
              timestamp: 1788883200,
              events: [
                {
                  id: 9001,
                  name: "<b>온라인 과제</b>",
                  timestart: 1788944400,
                  modulename: "assign",
                  url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=3960",
                  course: { id: 6549, fullname: "플랫폼기반프로그래밍 (059)" }
                },
                {
                  id: 9002,
                  name: "과제 2 - 온라인 시험",
                  timestart: 1788771600,
                  modulename: "quiz",
                  url: "https://plato.pusan.ac.kr/mod/quiz/view.php?id=52725",
                  course: { id: 6549, fullname: "플랫폼기반프로그래밍 (059)" }
                },
                {
                  id: 9003,
                  name: "사이트 공지",
                  timestart: 1788771600,
                  url: "https://plato.pusan.ac.kr/calendar/view.php"
                }
              ]
            }
          ]
        }
      ]
    },
    action: {
      events: [
        {
          id: 9001,
          name: "온라인 과제",
          timesort: 1788944400,
          modulename: "assign",
          url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=3960",
          overdue: false
        },
        {
          id: 9002,
          name: "과제 2 - 온라인 시험",
          timesort: 1788771600,
          modulename: "quiz",
          url: "https://plato.pusan.ac.kr/mod/quiz/view.php?id=52725",
          overdue: true
        }
      ]
    }
  };

  const activities = parser.normalizeMonthPayload(payload);
  assert.equal(activities.length, 2);
  assert.equal(activities[0].typeLabel, "시험");
  assert.equal(activities[0].sourceStatus.code, "overdue");
  assert.equal(activities[1].typeLabel, "과제");
  assert.equal(activities[1].sourceStatus.code, "incomplete");
  assert.equal(activities[1].title, "온라인 과제");
  assert.equal(activities[1].id, "calendar:9001");
});

test("does not infer completion when an activity is absent from action events", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      events: [{
        id: 3,
        name: "상태가 없는 과제",
        timestart: 1788944400,
        modulename: "assign",
        url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=4"
      }]
    },
    action: { events: [] }
  });
  assert.equal(activities[0].sourceStatus.code, "unknown");
  assert.equal(activities[0].sourceStatus.label, "상태 확인 불가");
});

test("accepts only HTTPS links on the exact PLATO origin", () => {
  assert.equal(
    parser.safePlatoUrl("/mod/assign/view.php?id=7"),
    "https://plato.pusan.ac.kr/mod/assign/view.php?id=7"
  );
  assert.equal(parser.safePlatoUrl("https://evil.example/mod/assign/view.php?id=7"), null);
  assert.equal(parser.safePlatoUrl("javascript:alert(1)"), null);
});

test("detail data enriches fields without inventing a URL", () => {
  const activity = {
    id: "calendar:1",
    eventId: 1,
    title: "기존 제목",
    courseName: "강좌명 확인 불가",
    typeLabel: "과제",
    typeCode: "assign",
    deadline: 1788944400,
    activityUrl: null,
    description: null,
    sourceStatus: { code: "unknown", label: "상태 확인 불가" },
    submissionStatus: null
  };
  const enriched = parser.mergeDetail(activity, {
    event: {
      id: 1,
      name: "실제 제목",
      description: "<p>실제 설명</p>",
      course: { id: 9, fullname: "실제 강좌" },
      url: "https://evil.example/activity"
    }
  });
  assert.equal(enriched.title, "실제 제목");
  assert.equal(enriched.description, "실제 설명");
  assert.equal(enriched.courseName, "실제 강좌");
  assert.equal(enriched.activityUrl, null);
});

test("uses explicit completion and submission fields from PLATO action data", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      events: [{
        id: 51,
        name: "상태 확인 과제",
        timestart: 1788944400,
        modulename: "assign",
        url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=51"
      }]
    },
    action: {
      events: [{
        id: 51,
        name: "상태 확인 과제",
        timesort: 1788944400,
        modulename: "assign",
        completionstatus: 1,
        submitted: true
      }]
    }
  });

  assert.equal(activities[0].sourceStatus.code, "completed");
  assert.equal(activities[0].submissionStatus, "제출 완료");
});

test("shows PLATO's submission action label without inferring a submission result", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      events: [{
        id: 52,
        name: "제출 전 과제",
        timestart: 1788944400,
        modulename: "assign",
        url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=52"
      }]
    },
    action: {
      events: [{
        id: 52,
        name: "제출 전 과제",
        timesort: 1788944400,
        modulename: "assign",
        action: { name: "Add submission" }
      }]
    }
  });

  assert.equal(activities[0].sourceStatus.code, "incomplete");
  assert.equal(activities[0].submissionStatus, "Add submission");
});
