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
    if (!/[<&\0]/.test(source)) return source.replace(/\s+/g, " ").trim();
    if (typeof DOMParser === "function") {
      const documentNode = new DOMParser().parseFromString(source, "text/html");
      return (documentNode.body.textContent || "").replace(/\s+/g, " ").trim();
    }
    return source.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  }

  function firstValue(...values) {
    return values.find((value) => value !== null && value !== undefined && value !== "");
  }

  function identifier(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    if (typeof value === "string" && /^\d+$/.test(value) && /[1-9]/.test(value)) return value.replace(/^0+/, "");
    return null;
  }

  function calendarId(value) {
    const id = identifier(value);
    return id && Number.isSafeInteger(Number(id)) ? Number(id) : null;
  }

  function courseIdentifier(value) {
    return [value?.course?.id, value?.courseid, value?.courseId].map(identifier).find(Boolean) || null;
  }

  function asUnixSeconds(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return null;
    }
    const seconds = number > 100000000000 ? number / 1000 : number;
    // A finite number can still exceed Date's supported +/-100,000,000 days.
    return seconds <= 8640000000000 ? Math.floor(seconds) : null;
  }

  function platoLocation(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = new URL(value, PLATO_ORIGIN);
      if (parsed.origin !== PLATO_ORIGIN || parsed.protocol !== "https:" || parsed.username || parsed.password) {
        return null;
      }
      const module = parsed.pathname.match(/^\/mod\/([^/]+)\/view\.php$/);
      if (module && (!/^[a-z][a-z0-9_]*$/.test(module[1]) || parsed.searchParams.getAll("id").length !== 1 ||
          !/^[1-9]\d*$/.test(parsed.searchParams.get("id") || ""))) return null;
      return { url: parsed.href, module: module ? module[1] : null, id: module ? parsed.searchParams.get("id") : null };
    } catch (_error) {
      return null;
    }
  }

  function safePlatoUrl(value) {
    return platoLocation(value)?.url || null;
  }

  function eventLocation(event, action) {
    const candidates = [
      event && event.url,
      event && event.viewurl,
      event && event.action && event.action.url,
      action && action.url,
      action && action.action && action.action.url
    ];
    let fallback = null;
    for (const value of candidates) {
      const location = platoLocation(value);
      if (!location) continue;
      if (location.module) return location;
      fallback ||= location;
    }
    return fallback;
  }

  function getCourse(event, action) {
    const source = event || {};
    const actionSource = action || {};
    const courseObject = source.course && typeof source.course === "object" ? source.course : {};
    const actionCourse = actionSource.course && typeof actionSource.course === "object" ? actionSource.course : {};
    const id = courseIdentifier(source) || courseIdentifier(actionSource);
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
      id,
      name: textFromHtml(name) || "강좌명 확인 불가"
    };
  }

  function looksLikeEvent(candidate, inheritedTimestamp) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const hasIdentity = candidate.id !== undefined || candidate.eventid !== undefined ||
      Boolean(eventLocation(candidate, null)?.id);
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
            found.push(event);
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
    return [event?.id, event?.eventid].map(identifier).find(Boolean) || null;
  }

  function createActionIndex(actions) {
    const entries = actions.map((action, order) => ({ action, order }));
    const byId = new Map(), metadata = new WeakMap();
    let byModule, byInstance;
    const add = (index, key, entry) => {
      if (!key) return;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(entry);
    };
    const describe = (event) => {
      if (metadata.has(event)) return metadata.get(event);
      const location = eventLocation(event, null);
      const result = {
        id: actionKey(event), moduleId: location?.id || null,
        moduleName: String(firstValue(location?.module, event.modulename) || "").trim().toLowerCase(),
        instance: identifier(event.instance), courseId: courseIdentifier(event),
        deadline: [event.timesort, event.timestart].map(asUnixSeconds).find(Boolean) || null
      };
      metadata.set(event, result);
      return result;
    };
    const moduleKey = info => info.moduleName && info.moduleId ? `${info.moduleName}:${info.moduleId}` : null;
    const instanceKey = info => info.moduleName && info.instance ? `${info.moduleName}:${info.instance}` : null;
    for (const entry of entries) add(byId, actionKey(entry.action), entry);
    return {
      byId, describe,
      fallback(info) {
        if (!info.moduleName || (!info.moduleId && !info.instance)) return [];
        // Most activities match by calendar ID. Parse the rest only if needed,
        // once for this payload, rather than once for every unmatched event.
        if (!byModule) {
          byModule = new Map(); byInstance = new Map();
          for (const entry of entries) {
            const candidate = describe(entry.action);
            add(byModule, moduleKey(candidate), entry);
            add(byInstance, instanceKey(candidate), entry);
          }
        }
        const modules = byModule.get(moduleKey(info)) || [];
        const instances = byInstance.get(instanceKey(info)) || [];
        if (!modules.length) return instances;
        if (!instances.length) return modules;
        return [...new Set([...modules, ...instances])].sort((a, b) => a.order - b.order);
      }
    };
  }

  function compatibleIdentity(event, action) {
    return (!event.moduleId || !action.moduleId || (event.moduleId === action.moduleId && event.moduleName === action.moduleName)) &&
      (!event.courseId || !action.courseId || event.courseId === action.courseId);
  }

  function findAction(event, index) {
    const info = index.describe(event);
    if (info.id) {
      const exact = (index.byId.get(info.id) || []).find(entry => compatibleIdentity(info, index.describe(entry.action)));
      if (exact) return exact.action;
    }
    const fallback = index.fallback(info).find(entry => {
      const candidate = index.describe(entry.action);
      const sameModuleId = info.moduleId && info.moduleId === candidate.moduleId;
      const sameInstance = info.instance && info.instance === candidate.instance;
      const sameTime = info.deadline === null || candidate.deadline === null || info.deadline === candidate.deadline;
      return compatibleIdentity(info, candidate) && (sameModuleId || sameInstance) &&
        info.moduleName === candidate.moduleName && sameTime;
    });
    return fallback ? fallback.action : null;
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

  function normalizeOne(event, action) {
    const eventTypeValue = firstValue(event.eventtype, action && action.eventtype);
    const rawEventType = eventTypeValue === undefined ? "" : String(eventTypeValue).toLowerCase();
    if (rawEventType === "open" || rawEventType === "opensubmission") {
      return null;
    }

    const location = eventLocation(event, action);
    const url = location?.url || null;
    const moduleValue = firstValue(
      location?.module,
      event.modulename,
      action && action.modulename
    );
    const moduleName = moduleValue === undefined ? "" : String(moduleValue).trim().toLowerCase();
    const componentValue = firstValue(event.component, action && action.component);
    const component = componentValue === undefined ? "" : String(componentValue);
    if (!moduleName && !component.startsWith("mod_")) {
      return null;
    }

    const eventId = calendarId(actionKey(event) || actionKey(action));
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
    const cmid = location?.id;
    const title = textFromHtml(firstValue(event.name, event.title, event.activityname, action && action.name)) || "활동명 확인 불가";
    const stableId = eventId !== null
      ? `calendar:${eventId}`
      : (cmid ? `activity:${course.id || "unknown"}:${moduleName || "module"}:${cmid}` : null);
    if (!stableId) {
      return null;
    }

    return {
      id: stableId,
      eventId,
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
    const actionIndex = createActionIndex(collectActionObjects(actionPayload));
    const normalized = collectEventObjects(monthPayload)
      .map(event => normalizeOne(event, findAction(event, actionIndex)))
      .filter(Boolean);

    const deduplicated = new Map();
    normalized.forEach((activity) => {
      // A generic calendar/day URL is shared navigation, not an activity identity.
      const semanticKey = platoLocation(activity.activityUrl)?.id
        ? activity.activityUrl + "|" + activity.deadline
        : activity.id + "|" + activity.deadline;
      const previous = deduplicated.get(semanticKey);
      if (!previous || (previous.sourceStatus.code === "unknown" && activity.sourceStatus.code !== "unknown")) {
        deduplicated.set(semanticKey, activity);
      }
    });
    return [...deduplicated.values()].sort((left, right) => left.deadline - right.deadline || left.title.localeCompare(right.title, "ko"));
  }

  function mergeDetail(activity, payload) {
    const expectedId = calendarId(activity.eventId);
    const event = payload && Object.prototype.hasOwnProperty.call(payload, "event") ? payload.event : payload;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      if (expectedId !== null) throw new Error("PLATO_DETAIL_UNAVAILABLE");
      return { ...activity };
    }
    const hasId = Object.prototype.hasOwnProperty.call(event, "id") || Object.prototype.hasOwnProperty.call(event, "eventid");
    if (expectedId !== null && hasId && calendarId(actionKey(event)) !== expectedId) {
      throw new Error("PLATO_DETAIL_EVENT_MISMATCH");
    }
    const detail = eventLocation(event, null);
    const original = platoLocation(activity.activityUrl);
    const detailStatus = explicitSourceStatus(event, null);
    const preferDetail = detail && (detail.module || !original?.module);
    const preferredUrl = preferDetail ? detail.url : activity.activityUrl;
    if (detail?.id && original?.id && (detail.module !== original.module || detail.id !== original.id)) {
      throw new Error("PLATO_DETAIL_ACTIVITY_MISMATCH");
    }
    const typeValue = firstValue(preferDetail ? detail.module : original?.module, event.modulename, activity.typeCode);
    const typeCode = typeValue === undefined ? null : String(typeValue).trim().toLowerCase();
    const deadline = [event.timesort, event.timestart].map(asUnixSeconds).find(Boolean);
    const courseName = getCourse(event, null).name;
    return {
      ...activity,
      deadline: deadline || activity.deadline,
      courseName: courseName === "강좌명 확인 불가" ? activity.courseName : courseName,
      title: textFromHtml(firstValue(event.name, event.title)) || activity.title,
      typeCode,
      typeLabel: OBSERVED_TYPE_LABELS[typeCode] || typeCode || activity.typeLabel,
      activityUrl: preferredUrl,
      description: textFromHtml(event.description) || activity.description,
      sourceStatus: detailStatus.code === "unknown" ? activity.sourceStatus : detailStatus,
      submissionStatus: submissionStatus(event, null) || activity.submissionStatus
    };
  }

  namespace.parser = Object.freeze({
    asUnixSeconds,
    mergeDetail,
    normalizeMonthPayload,
    safePlatoUrl
  });
})(globalThis);
