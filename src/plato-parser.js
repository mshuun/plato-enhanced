(function initPlatoParser(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const PLATO_ORIGIN = "https://plato.pusan.ac.kr";
  const OBSERVED_TYPE_LABELS = Object.freeze({
    assign: "과제",
    quiz: "시험"
  });

  function textFromHtml(value) {
    if (value === null || value === undefined) {
      return "";
    }
    const source = String(value);
    if (typeof DOMParser === "function") {
      const documentNode = new DOMParser().parseFromString(source, "text/html");
      return (documentNode.body.textContent || "").replace(/\s+/g, " ").trim();
    }
    return source.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  }

  function firstValue(...values) {
    return values.find((value) => value !== null && value !== undefined && value !== "");
  }

  function asUnixSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return null;
    }
    return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number);
  }

  function safePlatoUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = new URL(value, PLATO_ORIGIN);
      if (parsed.origin !== PLATO_ORIGIN || parsed.protocol !== "https:") {
        return null;
      }
      return parsed.href;
    } catch (_error) {
      return null;
    }
  }

  function moduleFromUrl(value) {
    const url = safePlatoUrl(value);
    if (!url) {
      return null;
    }
    const match = new URL(url).pathname.match(/^\/mod\/([^/]+)\/view\.php$/);
    return match ? match[1] : null;
  }

  function moduleIdFromUrl(value) {
    const url = safePlatoUrl(value);
    if (!url || !moduleFromUrl(url)) {
      return null;
    }
    const id = new URL(url).searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  }

  function eventUrl(event, action) {
    const candidates = [
      event && event.url,
      event && event.viewurl,
      event && event.action && event.action.url,
      action && action.url,
      action && action.action && action.action.url
    ];
    const safe = candidates.map(safePlatoUrl).filter(Boolean);
    return safe.find((url) => moduleFromUrl(url)) || safe[0] || null;
  }

  function getCourse(event, action) {
    const source = event || {};
    const actionSource = action || {};
    const courseObject = source.course && typeof source.course === "object" ? source.course : {};
    const actionCourse = actionSource.course && typeof actionSource.course === "object" ? actionSource.course : {};
    const id = firstValue(
      courseObject.id,
      source.courseid,
      source.courseId,
      actionCourse.id,
      actionSource.courseid,
      actionSource.courseId
    );
    const name = firstValue(
      courseObject.fullnamedisplay,
      courseObject.fullname,
      courseObject.displayname,
      courseObject.shortname,
      source.coursefullname,
      source.coursename,
      actionCourse.fullnamedisplay,
      actionCourse.fullname,
      actionCourse.displayname,
      actionCourse.shortname,
      actionSource.coursefullname,
      actionSource.coursename
    );
    return {
      id: id === undefined ? null : String(id),
      name: textFromHtml(name) || "강좌명 확인 불가"
    };
  }

  function looksLikeEvent(candidate, inheritedTimestamp) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const hasIdentity = candidate.id !== undefined || candidate.eventid !== undefined ||
      Boolean(moduleIdFromUrl(eventUrl(candidate, null)));
    const hasName = typeof firstValue(candidate.name, candidate.title, candidate.activityname) === "string";
    const hasTime = [candidate.timesort, candidate.timestart, candidate.time, candidate.timestamp, inheritedTimestamp].some(
      (value) => asUnixSeconds(value) !== null
    );
    return hasIdentity && hasName && hasTime;
  }

  function collectEventObjects(monthPayload) {
    const found = [];
    const seenObjects = new Set();

    function walk(node, inheritedTimestamp, depth) {
      if (!node || depth > 12) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, inheritedTimestamp, depth + 1));
        return;
      }
      if (typeof node !== "object" || seenObjects.has(node)) {
        return;
      }
      seenObjects.add(node);

      const timestamp = asUnixSeconds(firstValue(node.timestamp, node.timeusermidnight)) || inheritedTimestamp;
      if (Array.isArray(node.events)) {
        node.events.forEach((event) => {
          if (looksLikeEvent(event, timestamp)) {
            found.push({ event, dayTimestamp: timestamp });
          }
        });
      }

      Object.entries(node).forEach(([key, value]) => {
        if (key !== "events") {
          walk(value, timestamp, depth + 1);
        }
      });
    }

    walk(monthPayload, null, 0);
    return found;
  }

  function collectActionObjects(actionPayload) {
    if (!actionPayload || typeof actionPayload !== "object") {
      return [];
    }
    return Array.isArray(actionPayload.events) ? actionPayload.events.filter((event) => event && typeof event === "object") : [];
  }

  function actionKey(event) {
    const id = firstValue(event && event.id, event && event.eventid);
    return id === undefined ? null : String(id);
  }

  function findAction(event, actions) {
    const id = actionKey(event);
    if (id) {
      const exact = actions.find((action) => actionKey(action) === id);
      if (exact) {
        return exact;
      }
    }

    const eventUrlValue = eventUrl(event, null);
    const moduleId = moduleIdFromUrl(eventUrlValue);
    const moduleName = firstValue(event.modulename, moduleFromUrl(eventUrlValue));
    const courseId = firstValue(event.courseid, event.course && event.course.id);
    const deadline = asUnixSeconds(firstValue(event.timesort, event.timestart));

    return actions.find((action) => {
      const actionUrlValue = eventUrl(action, null);
      const sameModuleId = moduleId && moduleIdFromUrl(actionUrlValue) === moduleId;
      const sameInstance = event.instance !== undefined && action.instance !== undefined && String(event.instance) === String(action.instance);
      const sameModule = moduleName && firstValue(action.modulename, moduleFromUrl(actionUrlValue)) === moduleName;
      const actionCourseId = firstValue(action.courseid, action.course && action.course.id);
      const sameCourse = courseId === undefined || actionCourseId === undefined || String(courseId) === String(actionCourseId);
      const actionDeadline = asUnixSeconds(firstValue(action.timesort, action.timestart));
      const sameTime = deadline === null || actionDeadline === null || deadline === actionDeadline;
      return (sameModuleId || sameInstance) && sameModule && sameCourse && sameTime;
    }) || null;
  }

  function explicitSourceStatus(event, action) {
    const completedFields = [
      event && event.completed,
      event && event.iscompleted,
      event && event.completionstatus,
      event && event.completion_status,
      event && event.completion && event.completion.status,
      action && action.completed,
      action && action.iscompleted,
      action && action.completionstatus,
      action && action.completion_status,
      action && action.completion && action.completion.status
    ];
    if (completedFields.some((value) =>
      value === true ||
      value === 1 ||
      value === 2 ||
      value === 3 ||
      value === "1" ||
      value === "2" ||
      value === "3" ||
      value === "completed" ||
      value === "complete" ||
      value === "완료"
    )) {
      return { code: "completed", label: "PLATO에서 완료 확인", source: "PLATO 일정 데이터" };
    }

    if (action && action.overdue === true) {
      return { code: "overdue", label: "기한 초과", source: "PLATO 일정 데이터" };
    }

    if (completedFields.some((value) =>
      value === false ||
      value === 0 ||
      value === "0" ||
      value === "incomplete" ||
      value === "notcompleted" ||
      value === "미완료"
    )) {
      return { code: "incomplete", label: "미완료", source: "PLATO 완료 데이터" };
    }

    if (action) {
      return { code: "incomplete", label: "미완료", source: "PLATO 할 일 데이터" };
    }

    const rawStatus = textFromHtml(firstValue(
      event && event.status,
      event && event.completionstatus,
      event && event.completion_status,
      event && event.action && event.action.name
    ));
    return {
      code: "unknown",
      label: rawStatus || "상태 확인 불가",
      source: rawStatus ? "PLATO 원본 표시" : null
    };
  }

  function submissionStatus(event, action) {
    const submittedFields = [
      event && event.submitted,
      event && event.issubmitted,
      event && event.is_submitted,
      action && action.submitted,
      action && action.issubmitted,
      action && action.is_submitted
    ];
    if (submittedFields.some((value) => value === true || value === 1 || value === "1")) {
      return "제출 완료";
    }
    if (submittedFields.some((value) => value === false || value === 0 || value === "0")) {
      return "미제출";
    }

    const raw = firstValue(
      event && event.submissionstatus,
      event && event.submission_status,
      event && event.submission && event.submission.status,
      action && action.submissionstatus,
      action && action.submission_status,
      action && action.submission && action.submission.status
    );
    if (raw === true || raw === 1 || raw === "1") {
      return "제출 완료";
    }
    if (raw === false || raw === 0 || raw === "0") {
      return "미제출";
    }
    const explicitLabel = textFromHtml(raw);
    if (explicitLabel) {
      const normalizedLabel = explicitLabel.toLowerCase().replace(/[\s_-]+/g, "");
      if (["submitted", "complete", "completed"].includes(normalizedLabel)) {
        return "제출 완료";
      }
      if (["notsubmitted", "unsubmitted", "incomplete"].includes(normalizedLabel)) {
        return "미제출";
      }
      return explicitLabel;
    }

    const actionLabel = textFromHtml(firstValue(
      event && event.action && event.action.name,
      action && action.action && action.action.name
    ));
    return /제출|submit|submission/i.test(actionLabel) ? actionLabel : null;
  }

  function normalizeOne(event, action, dayTimestamp) {
    const eventTypeValue = firstValue(event.eventtype, action && action.eventtype);
    const rawEventType = eventTypeValue === undefined ? "" : String(eventTypeValue).toLowerCase();
    if (rawEventType === "open" || rawEventType === "opensubmission") {
      return null;
    }

    const url = eventUrl(event, action);
    const moduleValue = firstValue(
      event.modulename,
      action && action.modulename,
      moduleFromUrl(url)
    );
    const moduleName = moduleValue === undefined ? "" : String(moduleValue).trim().toLowerCase();
    const componentValue = firstValue(event.component, action && action.component);
    const component = componentValue === undefined ? "" : String(componentValue);
    const isModuleActivity = Boolean(
      moduleName ||
      moduleFromUrl(url) ||
      component.startsWith("mod_") ||
      (Number.isSafeInteger(Number(event.instance)) && Number(event.instance) > 0 && component.startsWith("mod_"))
    );
    if (!isModuleActivity) {
      return null;
    }

    const eventIdValue = firstValue(event.id, event.eventid, action && action.id, action && action.eventid);
    const eventId = eventIdValue === undefined ? null : Number(eventIdValue);
    const deadline = [
      action && action.timesort,
      event.timesort,
      event.timestart,
      action && action.timestart
    ].map(asUnixSeconds).find(Boolean);
    if (!deadline) {
      return null;
    }

    const course = getCourse(event, action);
    const cmid = moduleIdFromUrl(url);
    const title = textFromHtml(firstValue(event.name, event.title, event.activityname, action && action.name)) || "활동명 확인 불가";
    const stableId = Number.isSafeInteger(eventId) && eventId > 0
      ? `calendar:${eventId}`
      : (cmid ? `activity:${course.id || "unknown"}:${moduleName || "module"}:${cmid}` : null);
    if (!stableId) {
      return null;
    }

    return {
      id: stableId,
      eventId: Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null,
      courseId: course.id,
      courseName: course.name,
      title,
      typeCode: moduleName || null,
      typeLabel: OBSERVED_TYPE_LABELS[moduleName] || moduleName || "학습활동",
      deadline,
      activityUrl: url,
      description: textFromHtml(firstValue(event.description, action && action.description)) || null,
      sourceStatus: explicitSourceStatus(event, action),
      submissionStatus: submissionStatus(event, action),
      source: "PLATO 월간 일정"
    };
  }

  function normalizeMonthPayload(payload) {
    const monthPayload = payload && payload.month ? payload.month : payload;
    const actionPayload = payload && payload.action ? payload.action : {};
    const actions = collectActionObjects(actionPayload);
    const normalized = collectEventObjects(monthPayload)
      .map(({ event, dayTimestamp }) => normalizeOne(event, findAction(event, actions), dayTimestamp))
      .filter(Boolean);

    const deduplicated = new Map();
    normalized.forEach((activity) => {
      const semanticKey = activity.activityUrl
        ? activity.activityUrl + "|" + activity.deadline
        : activity.id;
      const previous = deduplicated.get(semanticKey);
      if (!previous || (previous.sourceStatus.code === "unknown" && activity.sourceStatus.code !== "unknown")) {
        deduplicated.set(semanticKey, activity);
      }
    });
    return [...deduplicated.values()].sort((left, right) => left.deadline - right.deadline || left.title.localeCompare(right.title, "ko"));
  }

  function mergeDetail(activity, payload) {
    const event = payload && payload.event ? payload.event : payload;
    if (!event || typeof event !== "object") {
      return { ...activity };
    }
    const detailUrl = eventUrl(event, null);
    const detailStatus = explicitSourceStatus(event, null);
    const preferredUrl = [detailUrl, activity.activityUrl].find((url) => moduleFromUrl(url)) || detailUrl || activity.activityUrl;
    const deadline = [event.timesort, event.timestart].map(asUnixSeconds).find(Boolean);
    return {
      ...activity,
      deadline: deadline || activity.deadline,
      courseName: getCourse(event, null).name === "강좌명 확인 불가" ? activity.courseName : getCourse(event, null).name,
      title: textFromHtml(firstValue(event.name, event.title)) || activity.title,
      typeCode: firstValue(event.modulename, activity.typeCode),
      typeLabel: OBSERVED_TYPE_LABELS[event.modulename] || event.modulename || activity.typeLabel,
      activityUrl: preferredUrl,
      description: textFromHtml(event.description) || activity.description,
      sourceStatus: detailStatus.code === "unknown" ? activity.sourceStatus : detailStatus,
      submissionStatus: submissionStatus(event, null) || activity.submissionStatus
    };
  }

  namespace.parser = Object.freeze({
    asUnixSeconds,
    collectEventObjects,
    mergeDetail,
    moduleFromUrl,
    normalizeMonthPayload,
    safePlatoUrl,
    textFromHtml
  });
})(globalThis);
