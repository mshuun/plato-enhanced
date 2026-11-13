(function initNespaParser(global) {
  "use strict";

  const ns = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const ORIGIN = "https://emerald.pusan.ac.kr";
  const DEFAULT_COURSE = "ds2026";
  const slugPattern = /^[a-zA-Z0-9_-]{1,64}$/;
  const clean = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const headerKey = value => clean(value).toLowerCase().replace(/[\s._()/-]+/g, "");
  const ASSIGNMENT_INFO_COLUMNS = Object.freeze({ maxSize: "maxsize", tokenSize: "tokensize", timeout: "timeout", maxTry: "maxtry", evaluation: "evaluation" });

  function isEmptyPlaceholder(row, kind) {
    if (row.cells.length !== 1 || row.cells[0].colSpan <= 1) return false;
    const text = clean(row.textContent).replace(/[.!。]$/, "").trim();
    // Match whole empty-list messages. Errors such as "접근 권한이 없습니다" and
    // "No data could be loaded" are not evidence that the list is empty.
    if (/^(?:no data(?: available)?(?: in table)?|데이터(?:가)?\s*없(?:습니다|음))$/i.test(text)) return true;
    if (kind === "assignments") return /^(?:no (?:assignments?|problems?)(?: (?:found|available))?|(?:등록된\s*|표시할\s*|아직\s*)?(?:과제|문제)(?:가|는)?\s*없(?:습니다|음))$/i.test(text);
    return /^(?:no submissions?(?: (?:found|available|made|yet))?|(?:아직\s*)?제출(?:한)?\s*(?:내역|기록|이력|결과)(?:이|가|은|는)?\s*없(?:습니다|음)|제출한 것이 없습니다)$/i.test(text);
  }

  function normalizeAssignmentInfo(value) {
    return Object.fromEntries(Object.keys(ASSIGNMENT_INFO_COLUMNS).map(key => {
      const text = typeof value?.[key] === "string" ? value[key].trim() : "";
      return [key, text || null];
    }));
  }

  function courseInfo(settings = {}) {
    try {
      const url = new URL(settings.courseUrl || `${ORIGIN}/${DEFAULT_COURSE}/`);
      const match = url.pathname.match(/^\/([a-zA-Z0-9_-]{1,64})\/?$/);
      const year = Number(settings.courseYear == null ? 2026 : settings.courseYear);
      if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash ||
          !match || !slugPattern.test(match[1]) || !Number.isInteger(year) || year < 2000 || year > 2200) return null;
      return { id: match[1], url: `${ORIGIN}/${match[1]}/`, year,
        name: clean(settings.courseName) || match[1] };
    } catch (_) { return null; }
  }

  function safeUrl(value, settings) {
    if (typeof value !== "string" || !value.trim()) return null;
    const course = settings ? courseInfo(settings) : null;
    if (settings && !course) return null;
    try {
      const url = new URL(value, course?.url || `${ORIGIN}/${DEFAULT_COURSE}/`);
      if (url.origin !== ORIGIN || url.username || url.password || /[\\\u0000-\u001f]/.test(value)) return null;
      const decoded = decodeURIComponent(url.pathname);
      if (decoded !== url.pathname && /(?:^|\/)\.\.?(?:\/|$)|[\\\u0000-\u001f]/.test(decoded)) return null;
      const segments = decoded.split("/").filter(Boolean);
      const candidate = segments[0] === "media" ? segments[1] : segments[0];
      if (!candidate || !slugPattern.test(candidate) || (course && candidate !== course.id)) return null;
      // URLs never carry credentials, and only the selected course and its media are accepted.
      if (segments[0] === "media" && segments.length < 3) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function readDocument(value) {
    if (value && typeof value.querySelectorAll === "function") return value;
    if (typeof value !== "string" || value.length > 5000000 || typeof DOMParser !== "function") return null;
    return new DOMParser().parseFromString(value, "text/html");
  }

  function authenticated(doc) {
    if (!doc) return false;
    const logout = doc.querySelector('#sidebar_logout a[href], a[href$="/logout"], a[href$="/logout/"]');
    if (logout) return true;
    if (doc.querySelector('input[type="password"]')) return false;
    return Boolean(clean(doc.querySelector("#sidebar_username span")?.textContent));
  }

  function parseDate(value, year) {
    const text = clean(value);
    const match = text.match(/^(?:(\d{4})\s*[-/.]\s*)?(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*\([^)]*\))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const parts = { year: match[1] ? Number(match[1]) : Number(year), month: Number(match[2]), day: Number(match[3]),
      hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0), explicitYear: Boolean(match[1]) };
    if (!Number.isInteger(parts.year) || parts.year < 2000 || parts.year > 2201 || parts.month < 1 || parts.month > 12 ||
        parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;
    const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
    if (utc.getUTCFullYear() !== parts.year || utc.getUTCMonth() !== parts.month - 1 || utc.getUTCDate() !== parts.day) return null;
    return { ...parts, timestamp: utc.getTime() / 1000 - 9 * 3600 };
  }

  function dateRange(startText, endText, year) {
    const start = parseDate(startText, year);
    let end = parseDate(endText, start?.year || year);
    // The starting year may not have Feb 29 even though the next year does.
    // Validate the rollover candidate before discarding a yearless deadline.
    if (start && !end) {
      const nextYear = parseDate(endText, start.year + 1);
      if (nextYear && !nextYear.explicitYear && nextYear.month < start.month) end = nextYear;
    }
    if (start && end && !end.explicitYear && end.timestamp < start.timestamp && end.month < start.month) {
      end = parseDate(endText, start.year + 1);
    }
    if (!end || (start && end.timestamp < start.timestamp)) return null;
    return { startTime: start?.timestamp || null, deadline: end.timestamp };
  }

  function linksFor(course, problemId) {
    const query = encodeURIComponent(problemId);
    return {
      detailUrl: `${course.url}submission_detail/?prob_id=${query}`,
      submissionUrl: `${course.url}submission/`
    };
  }

  function activityFromCatalog(item, settings) {
    const course = courseInfo(settings);
    if (!course || !item || !/^\d{1,40}$/.test(String(item.problemId)) ||
        !Number.isFinite(item.deadline) || item.deadline <= 0 || typeof item.title !== "string" || !clean(item.title)) return null;
    const problemId = String(item.problemId);
    const links = linksFor(course, problemId);
    return {
      provider: "nespa", id: `activity:nespa:${course.id}:${problemId}`, problemId,
      eventId: null, courseId: course.id, courseName: course.name,
      title: clean(item.title).slice(0, 500), typeCode: "assign", typeLabel: "NESPA 과제",
      deadline: item.deadline, startTime: Number.isFinite(item.startTime) ? item.startTime : null,
      assignmentInfo: normalizeAssignmentInfo(item.assignmentInfo),
      activityUrl: links.detailUrl, ...links,
      problemUrl: safeUrl(item.problemUrl, settings), sampleUrl: safeUrl(item.sampleUrl, settings),
      submissionStatus: "확인 필요", submissionCheck: "unavailable",
      sourceStatus: { code: "unknown", label: "제출 상태 확인 필요", source: "NESPA" },
      score: null, attempts: null, source: "NESPA 과제 목록"
    };
  }

  function parseAssignments(input, settings) {
    const doc = readDocument(input);
    const loggedIn = authenticated(doc);
    const course = courseInfo(settings);
    if (!doc || !course) return { authenticated: loggedIn, valid: false, activities: [], error: "invalid-page" };
    if (!loggedIn) return { authenticated: false, valid: false, activities: [], error: "auth-required" };
    let selected;
    for (const table of doc.querySelectorAll("table")) {
      for (const row of table.querySelectorAll("thead tr, tr:first-child")) {
        if (row.closest("table") !== table) continue;
        const headers = [...row.cells].map(cell => headerKey(cell.textContent));
        const columns = { id: headers.findIndex(value => ["#", "no", "번호", "problemid"].includes(value)),
          title: headers.indexOf("problem"), start: headers.indexOf("startdate"), end: headers.indexOf("enddate"),
          sample: headers.indexOf("sampledata"),
          ...Object.fromEntries(Object.entries(ASSIGNMENT_INFO_COLUMNS).map(([key, label]) => [key, headers.indexOf(label)])) };
        if (columns.id >= 0 && columns.title >= 0 && columns.end >= 0) { selected = { table, row, columns }; break; }
      }
      if (selected) break;
    }
    if (!selected) return { authenticated: true, valid: false, activities: [], error: "assignment-table-missing" };
    const activities = new Map();
    let skipped = 0;
    for (const row of selected.table.rows) {
      if (row === selected.row || row.closest("table") !== selected.table || row.parentElement?.tagName === "THEAD") continue;
      const cells = [...row.cells];
      if (!cells.length || !clean(row.textContent)) continue;
      if (cells.length === 1 && cells[0].colSpan > 1) {
        if (!isEmptyPlaceholder(row, "assignments")) skipped += 1;
        continue;
      }
      const c = selected.columns;
      const problemId = clean(cells[c.id]?.textContent);
      const title = clean(cells[c.title]?.textContent);
      const dates = dateRange(c.start >= 0 ? cells[c.start]?.textContent : "", cells[c.end]?.textContent, course.year);
      if (!/^\d{1,40}$/.test(problemId) || !title || !dates) { skipped += 1; continue; }
      const problemUrl = safeUrl(cells[c.title]?.querySelector("a[href]")?.getAttribute("href"), settings);
      const sampleCell = c.sample >= 0 ? cells[c.sample] : null;
      const sampleUrl = safeUrl(sampleCell?.querySelector("a[href]")?.getAttribute("href"), settings);
      const assignmentInfo = Object.fromEntries(Object.keys(ASSIGNMENT_INFO_COLUMNS).map(key => [key, c[key] >= 0 ? cells[c[key]]?.textContent : null]));
      const activity = activityFromCatalog({ problemId, title, ...dates, problemUrl, sampleUrl, assignmentInfo }, settings);
      if (activity) activities.set(activity.id, activity);
    }
    return { authenticated: true, valid: true, activities: [...activities.values()].sort((a, b) => a.deadline - b.deadline || a.problemId.localeCompare(b.problemId)),
      partial: skipped > 0, skipped };
  }

  function parseSubmissionDetail(input) {
    const doc = readDocument(input);
    const loggedIn = authenticated(doc);
    const unknown = { authenticated: loggedIn, valid: false, status: "unknown", score: null, attempts: null };
    if (!loggedIn) return { ...unknown, error: "auth-required" };
    const table = doc.querySelector("#score_table");
    if (!table || !table.tBodies.length) return { ...unknown, error: "submission-table-missing" };
    const idLabels = ["제출번호", "submissionid", "submissionnumber"];
    const header = [...table.querySelectorAll("thead tr")].find(row => row.closest("table") === table &&
      [...row.cells].some(cell => idLabels.includes(headerKey(cell.textContent)))) || table.rows[0];
    const labels = [...(header?.cells || [])].map(cell => headerKey(cell.textContent));
    const idIndex = labels.findIndex(value => idLabels.includes(value));
    const scoreIndex = labels.findIndex(value => ["채점점수", "점수", "score"].includes(value));
    if (idIndex < 0 || scoreIndex < 0) return { ...unknown, error: "submission-columns-missing" };
    const rows = [...table.tBodies].flatMap(body => [...body.rows]).filter(row => row !== header && row.closest("table") === table);
    const submissions = new Map();
    let unexpected = false, conflicting = false, emptyPlaceholder = false;
    for (const row of rows) {
      const id = clean(row.cells[idIndex]?.textContent);
      if (!/^\d+$/.test(id)) {
        if (clean(row.textContent)) {
          if (isEmptyPlaceholder(row, "submissions")) emptyPlaceholder = true;
          else unexpected = true;
        }
        continue;
      }
      const text = clean(row.cells[scoreIndex]?.textContent);
      const numeric = /^\d+(?:\.\d+)?$/.test(text);
      const value = numeric && Number.isFinite(Number(text)) ? Number(text) : null;
      if (!row.cells[scoreIndex] || (numeric && value === null)) conflicting = true;
      if (submissions.has(id) && submissions.get(id) !== value) conflicting = true;
      else submissions.set(id, value);
    }
    // One valid own record proves submission. Incomplete rows cannot prove a
    // total count or maximum, and repeated IDs represent the same attempt.
    unexpected ||= emptyPlaceholder && submissions.size > 0;
    if (!submissions.size && unexpected) return { ...unknown, error: "submission-rows-invalid" };
    let score = null;
    if (!unexpected && !conflicting) for (const value of submissions.values()) {
      if (value !== null && (score === null || value > score)) score = value;
    }
    return { authenticated: true, valid: true, status: submissions.size ? "submitted" : "unsubmitted",
      score, attempts: unexpected ? null : submissions.size, ...(unexpected || conflicting ? { partial: true } : {}) };
  }

  ns.nespaParser = Object.freeze({ courseInfo, safeUrl, parseDate, dateRange,
    normalizeAssignmentInfo, activityFromCatalog, parseAssignments, parseSubmissionDetail });
})(globalThis);
