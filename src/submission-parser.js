(function initSubmissionParser(global) {
  "use strict";
  const namespace = global.PlatoCalendarExt;
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function labelFromText(text) {
    const value = clean(text).toLowerCase();
    if (/^(제출\s*완료|제출됨|제출 완료\s*\(.*\)|submitted(?: for grading)?)$/.test(value)) return "제출 완료";
    if (/^(초안(?:\s*저장)?(?:\s*\(.*\))?|draft(?:\s*\(not submitted\))?)$/.test(value)) return "초안 저장";
    if (/^(재제출(?:\s*필요|\s*요청)?|reopened)$/.test(value)) return "재제출 필요";
    if (/^(미제출|제출\s*안\s*함|제출한 것이 없습니다\.?|no submissions? (?:yet|has been made)|no attempt|not submitted)$/.test(value)) return "미제출";
    return null;
  }

  function readDocument(doc) {
    // Never inspect instructions, attachments, or past-attempt tables for a status.
    const containers = [...doc.querySelectorAll(".submissionstatustable")];
    const values = [];
    // PLATO Coursemos renders a list, not Moodle's submissionstatustable.
    // Match the status card heading and the exact row label; never the grading row.
    if (doc.body?.id === "page-mod-assign-view") {
      for (const heading of doc.querySelectorAll("#region-main .csms-box-header h5")) {
        if (clean(heading.textContent) !== "제출 상태") continue;
        const card = heading.closest(".csms-box");
        if (!card || card.closest("#intro, .description, .activity-description, .assignattempt, .submissionhistory")) continue;
        for (const row of card.querySelectorAll(".csms-box-content li.cml-item")) {
          if (clean(row.querySelector(".cml-label")?.textContent) !== "제출 상태") continue;
          const label = labelFromText(row.querySelector(".cml-text")?.textContent);
          if (label) values.push(label);
        }
      }
    }
    for (const container of containers) {
      if (container.closest("#intro, .description, .activity-description, .assignintro, .assignattempt, .submissionhistory")) continue;
      for (const node of container.querySelectorAll(".submissionstatussubmitted, .submissionstatusdraft, .submissionstatusreopened")) {
        if (node.closest(".assignattempt, .submissionhistory")) continue;
        if (node.classList.contains("submissionstatusreopened")) values.push("재제출 필요");
        else if (node.classList.contains("submissionstatusdraft")) values.push("초안 저장");
        else if (node.childElementCount === 0) values.push("제출 완료");
        // Team-status cells with extra member requirements must not become completion evidence.
        else {
          const label = labelFromText(node.textContent);
          if (label) values.push(label);
        }
      }
      for (const row of container.querySelectorAll("tr")) {
        if (row.closest(".assignattempt, .submissionhistory")) continue;
        const cells = [...row.children].filter((cell) => /^(TD|TH)$/.test(cell.tagName));
        if (cells.length !== 2 || !/^(제출\s*상태|submission status)$/i.test(clean(cells[0].textContent))) continue;
        const label = labelFromText(cells[1].textContent);
        if (label) values.push(label);
      }
    }
    const distinct = [...new Set(values)];
    return distinct.length === 1 ? distinct[0] : null;
  }

  function parse(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return readDocument(doc);
  }

  function completionStatus(text, source) {
    const label = clean(text);
    if (label === "완료") return { code: "completed", label: "PLATO에서 완료 확인", source };
    if (label === "미완료") return { code: "incomplete", label: "미완료", source };
    return null;
  }

  function parseDetails(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const submissionStatus = readDocument(doc);
    const result = { submissionStatus, submissionCheck: submissionStatus ? "verified" : "unavailable" };
    if (doc.body?.id === "page-mod-assign-view") {
      const status = completionStatus(doc.querySelector(".mod-header-extrainfo #csms-mod-completion .text")?.textContent, "PLATO 활동 상태");
      if (status) Object.assign(result, { sourceStatus: status, completionCheck: "verified" });
    }
    return result;
  }

  function activityKey(value) {
    const safe = namespace.parser.safePlatoUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    const id = url.searchParams.get("id");
    if (!/^\/mod\/[a-z][a-z0-9_]*\/view\.php$/.test(url.pathname) || !/^[1-9]\d*$/.test(id || "")) return null;
    return `${namespace.config.origin}${url.pathname}?id=${id}`;
  }

  function reportUrl(courseId) {
    return /^[1-9]\d*$/.test(String(courseId || ""))
      ? `${namespace.config.origin}/report/ublogs/student/activity.php?id=${courseId}` : null;
  }

  function readCourseDocument(doc) {
    if (doc.body?.id !== "page-report-ublogs-student-activity") return null;
    const table = doc.querySelector("#region-main table.table-learning-student-activity");
    if (!table) return null;
    const candidates = new Map();
    for (const row of table.querySelectorAll("tbody tr")) {
      const key = activityKey(row.querySelector(".td-activity a[href]")?.getAttribute("href"));
      const status = completionStatus(row.querySelector(".td-status .csms-chips-status")?.textContent, "PLATO 활동 현황");
      if (!key || !status) continue;
      if (!candidates.has(key)) candidates.set(key, new Map());
      candidates.get(key).set(status.code, status);
    }
    return Object.fromEntries([...candidates].filter(([, values]) => values.size === 1)
      .map(([key, values]) => [key, [...values.values()][0]]));
  }

  function parseCourse(html) {
    return readCourseDocument(new DOMParser().parseFromString(html, "text/html"));
  }

  function assignmentUrl(value) {
    const safe = namespace.parser.safePlatoUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    const id = url.searchParams.get("id");
    if (url.pathname !== "/mod/assign/view.php" || !/^[1-9]\d*$/.test(id || "")) return null;
    // Strip action/user/group parameters: always request the current user's read view.
    return `${namespace.config.origin}/mod/assign/view.php?id=${id}`;
  }

  namespace.submissionParser = Object.freeze({ parse, parseDetails, readDocument, labelFromText, assignmentUrl,
    activityKey, reportUrl, parseCourse, readCourseDocument });
})(globalThis);
