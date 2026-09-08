(function (global) {
  'use strict';
  const ns = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const identity = (name, section) => `${clean(name).replace(/\s/g, '')}|${section}`;
  const days = '일월화수목금토';
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }
  function minutes(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null;
  }
  function readCourses(doc) {
    const courses = new Map();
    for (const link of doc.querySelectorAll('.ongoing-courses a.course-card[href]')) {
      const title = clean(link.querySelector('h5')?.textContent);
      const match = /^(.*?)\s*\((\d+)\)$/.exec(title);
      let url;
      try { url = new URL(link.getAttribute('href'), 'https://plato.pusan.ac.kr/'); } catch (_) { continue; }
      if (!match || url.origin !== 'https://plato.pusan.ac.kr' || url.pathname !== '/course/view.php' || !/^\d+$/.test(url.searchParams.get('id') || '')) continue;
      const id = url.searchParams.get('id');
      courses.set(id, { id, title, name: match[1], section: match[2], key: identity(match[1], match[2]),
        url: `https://plato.pusan.ac.kr/course/view.php?id=${id}` });
    }
    return [...courses.values()];
  }
  function parseTimetable(doc) {
    if (!doc.querySelector('#ptTable')) return [];
    const result = new Map();
    for (const modal of doc.querySelectorAll('.schedule-info')) {
      const title = clean(modal.querySelector('.modal-title')?.textContent);
      const match = /^(.*?)\[(\d+)\]/.exec(title);
      if (!match) continue;
      let range = null, last = null;
      for (const dt of modal.querySelectorAll('dt')) {
        if (dt.nextElementSibling?.tagName !== 'DD') continue;
        const label = clean(dt.textContent), value = clean(dt.nextElementSibling.textContent);
        if (label === '강의일자') {
          const dates = /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/.exec(value);
          range = dates && validDate(dates[1]) && validDate(dates[2]) && dates[1] <= dates[2] ? dates.slice(1) : null;
          last = null;
        } else if (label === '강의시간') {
          last = null;
          const time = /^([일월화수목금토])요일\s+(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})(?:\s*\(.*\))?$/.exec(value);
          if (!range || !time) continue;
          const start = minutes(time[2]), end = minutes(time[3]);
          if (start === null || end === null || end <= start) continue;
          last = { key: identity(match[1], match[2]), day: days.indexOf(time[1]), start, end,
            from: range[0], to: range[1], room: '' };
          result.set([last.key, last.day, start, end, ...range].join('|'), last);
        } else if (label === '강의실' && last) last.room = value.slice(0, 100);
      }
    }
    return [...result.values()];
  }
  function connect(courses, timetable) {
    const matches = new Map();
    for (const course of courses) {
      if (!matches.has(course.key)) matches.set(course.key, []);
      matches.get(course.key).push(course);
    }
    return timetable.flatMap(item => matches.get(item.key)?.length === 1
      ? [{ ...item, courseId: matches.get(item.key)[0].id }] : []);
  }
  function validMeeting(item, courses) {
    return item && courses.some(course => course.id === item.courseId && course.key === item.key) &&
      Number.isInteger(item.day) && item.day >= 0 && item.day <= 6 &&
      Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end < 1440 && item.end > item.start &&
      validDate(item.from) && validDate(item.to) && item.from <= item.to && typeof item.room === 'string';
  }
  function koreaNow(now = Date.now()) {
    const shifted = new Date(now + 9 * 3600000);
    return { date: shifted.toISOString().slice(0, 10), day: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
  }
  function select(meetings, now = Date.now()) {
    const local = koreaNow(now);
    const today = meetings.filter(item => item.day === local.day && item.from <= local.date && item.to >= local.date)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const active = today.filter(item => item.start <= local.minute && local.minute < item.end);
    let upcoming = [];
    for (let offset = 0; offset <= 7 && !upcoming.length; offset++) {
      const date = koreaNow(now + offset * 86400000);
      upcoming = meetings.filter(item => item.day === date.day && item.from <= date.date && item.to >= date.date &&
        (offset > 0 || item.start > local.minute)).sort((a, b) => a.start - b.start)
        .map(item => ({ ...item, date: date.date }));
      if (upcoming.length) upcoming = upcoming.filter(item => item.start === upcoming[0].start);
    }
    return { ...local, active, today, upcoming };
  }
  ns.classScheduleModel = Object.freeze({ readCourses, parseTimetable, connect, validMeeting, select, koreaNow,
    time: value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` });
})(globalThis);
