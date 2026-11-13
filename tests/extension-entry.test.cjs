"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("extension toolbar action opens options and worker retains timetable entry", async () => {
  let click, installed, opened = 0, cleaned = 0;
  const imports = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8"), {
    importScripts(...names) { imports.push(...names); },
    PlatoCalendarExt: { async cleanupLegacyNespa() { cleaned++; } },
    chrome: { action: { onClicked: { addListener(fn) { click = fn; } } }, runtime: { onInstalled: { addListener(fn) { installed = fn; } }, async openOptionsPage() { opened++; } } }
  });
  assert.ok(imports.includes("schedule-background.js"));
  assert.ok(imports.includes("nespa-background.js"));
  assert.ok(!imports.includes("portal-background.js"));
  assert.ok(!imports.includes("portal-navigation.js"));
  assert.equal(typeof click, "function");
  await click();
  assert.equal(opened, 1);
  assert.ok(imports.includes("nespa-migration.js"));
  installed();
  assert.equal(cleaned, 1);
});
