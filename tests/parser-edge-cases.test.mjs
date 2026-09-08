import assert from "node:assert/strict";
import test from "node:test";

globalThis.PlatoCalendarExt = {};
await import("../src/plato-parser.js");

const parser = globalThis.PlatoCalendarExt.parser;

test("excludes opening events explicitly identified by PLATO's timeline code", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      events: [
        {
          id: 1,
          name: "시험 시작",
          eventtype: "open",
          timestart: 1000,
          modulename: "quiz",
          url: "https://plato.pusan.ac.kr/mod/quiz/view.php?id=20"
        },
        {
          id: 2,
          name: "시험 종료",
          eventtype: "close",
          timestart: 2000,
          modulename: "quiz",
          url: "https://plato.pusan.ac.kr/mod/quiz/view.php?id=20"
        }
      ]
    }
  });
  assert.equal(activities.length, 1);
  assert.equal(activities[0].title, "시험 종료");
});

test("uses an observed module URL ID only when a calendar event ID is absent", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      events: [{
        name: "ID 없는 과제",
        timestart: 2000,
        modulename: "assign",
        courseid: 10,
        url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=30"
      }]
    }
  });
  assert.equal(activities.length, 1);
  assert.equal(activities[0].id, "activity:10:assign:30");
});

test("deduplicates identical activity URL and deadline pairs", () => {
  const event = {
    name: "중복 과제",
    timestart: 2000,
    modulename: "assign",
    url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=30"
  };
  const activities = parser.normalizeMonthPayload({
    month: { events: [{ ...event, id: 1 }, { ...event, id: 2 }] }
  });
  assert.equal(activities.length, 1);
});

test("does not invent a deadline from the containing day", () => {
  const activities = parser.normalizeMonthPayload({
    month: {
      weeks: [{
        days: [{
          timestamp: 2_100,
          events: [{
            id: 41,
            name: "날짜 컨테이너 기반 과제",
            modulename: "assign",
            url: "https://plato.pusan.ac.kr/mod/assign/view.php?id=31"
          }]
        }]
      }]
    }
  });

  assert.equal(activities.length, 0);
});
