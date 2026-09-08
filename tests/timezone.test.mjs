import assert from "node:assert/strict";
import test from "node:test";

globalThis.PlatoCalendarExt = {};
await import("../src/calendar-model.js");

const model = globalThis.PlatoCalendarExt.calendarModel;

test("groups deadlines using the timezone reported by PLATO", () => {
  const timestamp = Date.parse("2026-09-02T16:30:00Z") / 1000;
  assert.equal(model.dayKeyFromTimestamp(timestamp, "Asia/Seoul"), "2026-09-03");
  const groups = model.groupActivitiesByDay([{ id: "calendar:1", deadline: timestamp }], "Asia/Seoul");
  assert.equal(groups.get("2026-09-03")[0].id, "calendar:1");
});
