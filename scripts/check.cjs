"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = new Set([manifest.background.service_worker, manifest.options_ui.page]);
for (const group of manifest.web_accessible_resources || []) for (const file of group.resources) files.add(file);
for (const content of manifest.content_scripts) for (const file of [...(content.js || []), ...(content.css || [])]) files.add(file);
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) throw new Error(`Missing runtime resource: ${file}`);
  const source = fs.readFileSync(absolute, "utf8");
  const references = file.endsWith(".html") ? [...source.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]) :
    file.endsWith(".js") ? [...source.matchAll(/importScripts\(([^)]+)\)/g)].flatMap(match => [...match[1].matchAll(/["']([^"']+)["']/g)].map(value => value[1])) : [];
  for (const reference of references) {
    if (/^(?:[a-z]+:|#)/i.test(reference)) continue;
    files.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), reference)));
  }
}
for (const dir of ["src", "weekly", "styles", "assets"]) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/");
    if (!files.has(relative)) throw new Error(`Unreferenced runtime file: ${relative}`);
  }
}
for (const dir of ["src", "weekly", ".", "scripts"]) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!/\.(?:js|cjs)$/.test(name)) continue;
    execFileSync(process.execPath, ["--check", path.join(root, dir, name)], { stdio: "inherit" });
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (manifest.version !== pkg.version || manifest.version !== lock.version || manifest.version !== lock.packages[""].version || manifest.manifest_version !== 3) throw new Error("Unexpected package version");
console.log(`Runtime resources (${files.size}), reachability and JavaScript syntax verified.`);
