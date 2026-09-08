import assert from "node:assert/strict";
import test from "node:test";

globalThis.PlatoCalendarExt = {};
await import("../src/calendar-model.js");

const model = globalThis.PlatoCalendarExt.calendarModel;

test("builds a stable six-week monthly grid beginning on Sunday", () => {
  const grid = model.getMonthGrid(2026, 9);
  assert.equal(grid.length, 42);
  assert.equal(grid[0].key, "2026-08-30");
  assert.equal(grid[6].column, 6);
  assert.equal(grid[41].key, "2026-10-10");
});

test("month navigation crosses year boundaries", () => {
  assert.deepEqual(model.addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(model.addMonths(2026, 12, 1), { year: 2027, month: 1 });
});

test("status precedence preserves manual and explicit PLATO states", () => {
  const now = 1_000_000;
  const activity = { deadline: now + 100, sourceStatus: { code: "incomplete" } };
  assert.equal(model.classifyActivity(activity, true, now, 48).code, "manual");
  assert.equal(
    model.classifyActivity({ ...activity, sourceStatus: { code: "completed" } }, false, now, 48).code,
    "completed"
  );
  assert.equal(
    model.classifyActivity({ ...activity, sourceStatus: { code: "overdue" } }, false, now, 48).code,
    "overdue"
  );
  assert.equal(model.classifyActivity(activity, false, now, 48).code, "due-soon");
});

test("unknown source remains unknown when a deadline is not imminent", () => {
  const activity = { deadline: 2_000_000, sourceStatus: { code: "unknown" } };
  assert.equal(model.classifyActivity(activity, false, 1_000_000, 48).code, "unknown");
});
