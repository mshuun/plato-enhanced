/* Parses the PLATO quiz view only. Never starts or resumes an attempt. */
((root) => {
  'use strict';
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const number = value => /^\d+(?:[.,]\d+)?$/.test(value);
  function grade(value) {
    const total = value.match(/^총점\s*(\d+(?:[.,]\d+)?)\s*점\s*중\s*(\d+(?:[.,]\d+)?)\s*점/);
    if (total) return `${total[2]} / ${total[1]}`;
    return /^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s*점)?$/.test(value) ? value : '';
  }
  function parse(doc) {
    const region = doc.querySelector('#region-main');
    if (!region) return null;
    const completion = text(doc.querySelector('#csms-mod-completion, .csms-mod-completion'));
    const result = {completion: /^(완료|미완료)$/.test(completion) ? completion : '', submission: '', grading: '', score: '', scoreLabel: '점수', attempt: ''};
    const attempts = [...region.querySelectorAll('.list-of-attempts > li')].map((row, index) => ({
      number: Number(text(row.querySelector('h6')).match(/(\d+)\s*차/)?.[1] || index + 1),
      state: text(row.querySelector('.user-info-item-state .user-info-value')),
      gradeText: text(row.querySelector('.user-info-item-grade .user-info-value')),
      grading: [...row.querySelectorAll('.user-info-item')].find(item => /^(채점 상태|채점)$/.test(text(item.querySelector('.user-info-label'))))
    })).sort((a, b) => b.number - a.number);
    const latest = attempts[0];
    if (latest) {
      result.attempt = `${latest.number}차 응시`;
      result.submission = /^(종료|완료|Finished)$/i.test(latest.state) ? '제출 완료'
        : /진행|응시 중|In progress/i.test(latest.state) ? '응시 중'
        : /기한.*초과|Overdue/i.test(latest.state) ? '제출 기한 초과'
        : /제출.*않|미제출|포기|Never submitted/i.test(latest.state) ? '미제출'
        : latest.state;
      result.score = result.submission === '제출 완료' ? grade(latest.gradeText) : '';
      const explicit = text(latest.grading?.querySelector('.user-info-value'));
      result.grading = explicit || (/채점.*필요|채점.*대기|미채점|Not yet graded|Requires grading/i.test(latest.gradeText) ? '채점 대기'
        : result.score ? '채점 완료'
        : result.submission === '제출 완료' ? '채점 정보 미공개' : '해당 없음');
    } else {
      const start = [...region.querySelectorAll('.quizstartbuttondiv button')].find(button => /^(시험 응시|퀴즈 응시|Attempt quiz now)$/i.test(text(button)));
      if (start) { result.submission = '미응시'; result.grading = '해당 없음'; }
    }
    // This is the student's aggregate grade, not the maximum possible grade.
    const aggregate = region.querySelector('.your-grade');
    const earned = text(aggregate?.querySelector('.mygrade'));
    const maximum = text(aggregate?.querySelector('.quizgrade'));
    if (number(earned)) {
      result.score = number(maximum) ? `${earned} / ${maximum}` : earned;
      result.scoreLabel = text(aggregate.querySelector('.method')).replace(/[:：]\s*$/, '') || '점수';
      if (result.submission === '제출 완료' && !result.grading) result.grading = '채점 완료';
    }
    return result;
  }
  root.PlatoQuizStatus = {parse};
  if (typeof module !== 'undefined' && module.exports) module.exports = {parse};
})(typeof globalThis !== 'undefined' ? globalThis : this);
