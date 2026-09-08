import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manifest uses MV3 with storage and the student timetable host", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://onestop.pusan.ac.kr/*"]);
  assert.equal(manifest.background.service_worker, "src/schedule-background.js");
  assert.ok(manifest.content_scripts.every((script) =>
    script.matches.length === 1 && ["https://plato.pusan.ac.kr/*", "https://plato.pusan.ac.kr/course/view.php*"].includes(script.matches[0])
  ));
});

test("page bridge exposes only the observed calendar operations", async () => {
  const bridge = await readFile(new URL("src/page-bridge.js", root), "utf8");
  assert.match(bridge, /core_calendar\/repository/);
  assert.match(bridge, /block_timeline\/calendar_events_repository/);
  assert.match(bridge, /getCalendarMonthData/);
  assert.match(bridge, /getEventById/);
  assert.doesNotMatch(bridge, /Authorization|Cookie|MOODLE_WSTOKEN|sesskey/);
  assert.doesNotMatch(bridge, /fetch\s*\(/);
});

test("insertion selectors match the observed PLATO dashboard structure", async () => {
  const configSource = await readFile(new URL("src/config.js", root), "utf8");
  assert.match(configSource, /body#page-site-index \.dashboard-container > \.ongoing-courses/);
  const contentSource = await readFile(new URL("src/content.js", root), "utf8");
  assert.match(contentSource, /insertBefore\(existing, ongoingCourses\)/);
  assert.match(contentSource, /getElementById\(config\.rootId\)/);
  assert.match(contentSource, /const target = document\.documentElement/);
});

test("all authored CSS selectors are extension-scoped", async () => {
  const css = await readFile(new URL("styles/calendar.css", root), "utf8");
  const selectorLines = css.split("\n").filter((line) => line.trim().endsWith("{") && !line.trim().startsWith("@"));
  const unscoped = selectorLines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.includes("plato-calendar-ext") && !trimmed.startsWith("#plato-calendar-ext-root");
  });
  assert.deepEqual(unscoped, []);
});
