import { createHash } from 'node:crypto';
import { OUTCOMES, type Outcome } from '../report-rules.js';
import type {
  CenterReport,
  CourseReport,
  RegisterReport,
  ReportHead,
  StudentReport,
  StudentsReport,
  TeacherReport,
} from '../reports.service.js';
import {
  attendanceDonut,
  calendar,
  columns,
  delta,
  documentHtml,
  empty,
  flags,
  footer,
  hero,
  kpis,
  legend,
  meter,
  pill,
  rateColor,
  section,
  signoff,
  subject,
  table,
  type Brand,
  type BarPoint,
} from './components.js';
import type { Fmt } from './format.js';
import { bdi, html, type Html } from './html.js';
import { COLORS, OUTCOME_COLORS } from './theme.js';

export type Rendered = { html: string; footer: string; landscape: boolean; fileName: string };

const COUNTED_STACK: Outcome[] = ['PRESENT', 'LATE', 'EXCUSED', 'ABSENT', 'UNRECORDED'];

/** A short code that identifies one issued report (shown on it, so a printout can be traced). */
function reference(kind: string, id: string, head: ReportHead) {
  const hash = createHash('sha256').update(`${kind}|${id}|${head.period.from}|${head.period.to}|${head.generatedAt}`).digest('hex');
  return `R-${hash.slice(0, 4).toUpperCase()}-${hash.slice(4, 8).toUpperCase()}`;
}

const slug = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 60);

function chips(f: Fmt, head: ReportHead) {
  const out: (string | Html)[] = [f.period(head.period.from, head.period.to), f.t('days', { n: f.number(head.period.days) })];
  if (head.filters.teacher) out.push(html`${f.t('teacher')}: ${bdi(head.filters.teacher.name)}`);
  if (head.filters.course) out.push(html`${f.t('course')}: ${bdi(head.filters.course.title)}`);
  return out;
}

function finish(f: Fmt, brand: Brand, title: string, body: Html, fileBase: string, landscape = false): Rendered {
  return {
    html: documentHtml(f, { title, body }),
    footer: footer(f, brand.center, title),
    landscape,
    fileName: `${slug(fileBase)}.pdf`,
  };
}

const ratingText = (f: Fmt, r: number | null) => (r === null ? '—' : f.rating(r));

/** Trend columns: seats per outcome in each bucket, the attendance rate on top. */
function attendanceTrend(f: Fmt, trend: { unit: string; points: { from: string; to: string; counts: Record<Outcome, number>; attendanceRate: number | null }[] }) {
  const points: BarPoint[] = trend.points.map((p) => ({
    label: trend.unit === 'month' ? f.month(p.from) : f.dayMonth(p.from),
    segments: COUNTED_STACK.map((o) => ({ value: p.counts[o], color: OUTCOME_COLORS[o] })),
    top: p.attendanceRate === null ? undefined : f.percent(p.attendanceRate),
  }));
  return html`<div class="card keep">${columns(f, points)}${legend(f, COUNTED_STACK)}</div>`;
}

function trendHint(f: Fmt, unit: string) {
  return f.t(`trendBy.${unit as 'day' | 'week' | 'month'}`);
}

// ───────── Student ─────────

export function studentPdf(f: Fmt, brand: Brand, r: StudentReport): Rendered {
  const s = r.summary;
  const title = f.t('student.title');
  const late = s.counts.LATE ? f.t('lateTimes', { n: f.number(s.counts.LATE) }) : f.t('neverLate');
  const courses = r.courses.filter((c) => c.held > 0 || c.examAverage !== null);

  const body = html`
    ${hero(f, brand, { kind: f.t('student.kind'), title, subtitle: f.t('student.subtitle'), chips: chips(f, r) })}
    ${subject(
      r.student.name,
      [
        [f.t('grade'), r.student.grade ? bdi(r.student.grade) : null],
        [f.t('email'), html`<span class="ltr">${r.student.email}</span>`],
        [f.t('phone'), r.student.phone ? html`<span class="ltr">${r.student.phone}</span>` : null],
        [f.t('parentPhone'), r.student.parentPhone ? html`<span class="ltr">${r.student.parentPhone}</span>` : null],
        [f.t('teachers'), r.student.teachers.length ? html`${r.student.teachers.map((t, i) => html`${i ? f.t('sep') : ''}${bdi(t)}`)}` : null],
      ],
      r.student.status === 'ACTIVE' ? undefined : html`<span class="flag">${f.t(`accountStatus.${r.student.status}`)}</span>`,
    )}
    ${kpis(
      [
        {
          label: f.t('attendanceRate'),
          value: f.percent(s.attendanceRate),
          sub: html`${f.t('attendedOf', { a: f.number(s.counts.PRESENT + s.counts.LATE), n: f.number(s.counts.PRESENT + s.counts.LATE + s.counts.ABSENT) })} ${delta(f, s.attendanceRate, r.previous.attendanceRate, 'rate')}`,
          accent: rateColor(s.attendanceRate),
        },
        { label: f.t('attendedTime'), value: f.duration(s.attendedMinutes), sub: f.t('ofHeldTime', { time: f.duration(s.heldMinutes) }), accent: COLORS.primary },
        { label: f.t('punctuality'), value: f.percent(s.punctualityRate), sub: late, accent: COLORS.amber },
        {
          label: f.t('averageRating'),
          value: ratingText(f, s.averageRating),
          sub: delta(f, s.averageRating, r.previous.averageRating, 'points'),
          accent: '#0ea5e9',
        },
        {
          label: f.t('examAverage'),
          value: f.score(s.exams.average),
          sub: html`${f.t('examsCount', { n: f.number(s.exams.count) })} ${delta(f, s.exams.average, r.previous.examAverage, 'points')}`,
          accent: '#10b981',
        },
      ],
      true,
    )}
    ${r.flags.length ? section(f.t('needsAttention'), html`<div class="card keep">${flags(f, r.flags)}<div class="small muted" style="margin-top:4px">${f.t('needsAttentionHint')}</div></div>`) : ''}
    ${section(
      f.t('attendance'),
      html`<div class="split keep">
        <div class="card">${attendanceDonut(f, s.counts, s.attendanceRate)}</div>
        <div class="card">${r.period.days <= 62 ? html`${calendar(f, r.period.from, r.period.to, r.days)}<div style="margin-top:6px">${legend(f, ['PRESENT', 'LATE', 'EXCUSED', 'ABSENT', 'UNRECORDED', 'UPCOMING', 'CANCELED'])}</div>` : attendanceTrend(f, r.trend)}</div>
      </div>`,
      { hint: f.t('rateRule') },
    )}
    ${r.period.days > 14 && r.period.days <= 62 && r.trend.points.length > 1 ? section(f.t('trend'), attendanceTrend(f, r.trend), { hint: trendHint(f, r.trend.unit), keep: true }) : ''}
    ${courses.length > 1
      ? section(
          f.t('byCourse'),
          table(
            [f.t('course'), f.t('teacher'), { label: f.t('held'), c: true }, { label: f.t('outcome.PRESENT'), c: true }, { label: f.t('outcome.LATE'), c: true }, { label: f.t('outcome.ABSENT'), c: true }, { label: f.t('outcome.EXCUSED'), c: true }, f.t('attendanceRate'), { label: f.t('rating'), c: true }, { label: f.t('examAverage'), c: true }],
            courses.map(
              (c) => html`<tr>
                <td class="strong">${c.title ? bdi(c.title) : f.t('noCourse')}</td><td>${bdi(c.teacher)}</td>
                <td class="c num">${f.number(c.held)}</td><td class="c num">${f.number(c.counts.PRESENT)}</td><td class="c num">${f.number(c.counts.LATE)}</td><td class="c num">${f.number(c.counts.ABSENT)}</td><td class="c num">${f.number(c.counts.EXCUSED)}</td>
                <td style="width:22%">${meter(c.attendanceRate, f.percent(c.attendanceRate), { color: rateColor(c.attendanceRate) })}</td>
                <td class="c num">${ratingText(f, c.averageRating)}</td><td class="c num">${f.score(c.examAverage)}</td>
              </tr>`,
            ),
          ),
        )
      : ''}
    ${section(
      f.t('sessionLog'),
      r.sessions.length
        ? table(
            ['#', f.t('date'), f.t('session'), f.t('teacher'), f.t('attendanceCol'), { label: f.t('rating'), c: true }, f.t('lessonNotes')],
            r.sessions.map(
              (x, i) => html`<tr>
                <td class="num faint">${f.number(i + 1)}</td>
                <td class="nowrap"><span class="strong">${f.dayShort(x.startAt)}</span><span class="note num">${f.time(x.startAt)} · ${f.duration(x.minutes)}</span></td>
                <td><bdi class="strong">${x.title}</bdi>${x.course ? html`<span class="note">${bdi(x.course.title)}</span>` : ''}</td>
                <td>${bdi(x.teacher.name)}</td>
                <td>${pill(f, x.outcome)}</td>
                <td class="c num">${x.rating === null ? '—' : f.number(x.rating)}</td>
                <td style="width:30%">${notes(f, x)}</td>
              </tr>`,
            ),
          )
        : empty(f.t('noSessions')),
      { hint: f.t('sessionsCount', { n: f.number(r.sessions.length) }) },
    )}
    ${section(
      f.t('exams'),
      r.exams.length
        ? table(
            [f.t('exam'), f.t('course'), f.t('month'), { label: f.t('score'), c: true }, f.t('percentVsGroup'), f.t('feedback')],
            r.exams.map(
              (e) => html`<tr>
                <td class="strong">${bdi(e.title)}</td><td>${bdi(e.course.title)}</td><td class="nowrap">${f.month(e.month)}</td>
                <td class="c num nowrap">${f.t('outOf', { a: f.number(e.score), n: f.number(e.totalMarks) })}</td>
                <td style="width:24%">${meter(e.percent, f.score(e.percent), { max: 100, marker: e.groupSize > 1 ? e.groupAverage : null, color: e.percent >= 50 ? COLORS.primary : '#e11d48' })}${e.groupSize > 1 ? html`<span class="note">${f.t('groupAverage', { avg: f.score(e.groupAverage), n: f.number(e.groupSize) })}</span>` : ''}</td>
                <td>${e.feedback ? bdi(e.feedback) : html`<span class="faint">—</span>`}</td>
              </tr>`,
            ),
          )
        : empty(f.t('noExams')),
    )}
    ${r.finance
      ? section(
          f.t('finance'),
          html`${kpis([
            { label: f.t('chargedSessions'), value: f.number(r.finance.sessions), accent: COLORS.primary },
            { label: f.t('chargedTime'), value: f.duration(r.finance.minutes), accent: '#0ea5e9' },
            { label: f.t('fees'), value: f.money(r.finance.fees, r.finance.currency), accent: '#10b981', sub: r.finance.missingRates ? f.t('missingRates', { n: f.number(r.finance.missingRates) }) : undefined },
          ])}
          ${r.finance.courses.length
            ? html`<div style="margin-top:8px">${table(
                [f.t('course'), { label: f.t('sessionsCol'), c: true }, { label: f.t('time'), c: true }, { label: f.t('fees'), c: true }],
                r.finance.courses.map(
                  (c) => html`<tr><td class="strong">${c.title ? bdi(c.title) : f.t('noCourse')}</td><td class="c num">${f.number(c.sessions)}</td><td class="c num">${f.duration(c.minutes)}</td><td class="c num strong">${f.money(c.fees, r.finance!.currency)}</td></tr>`,
                ),
              )}</div>`
            : ''}`,
          { keep: true },
        )
      : ''}
    ${signoff(f, reference('student', r.student.id, r), r.generatedAt, [f.t('sign.teacher'), f.t('sign.parent'), f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('student.file')}-${r.student.name}-${r.period.from}`);
}

function notes(f: Fmt, x: { progress: string | null; homework: string | null; comment: string | null }) {
  const lines: Html[] = [];
  if (x.progress) lines.push(html`<span class="note"><b>${f.t('progress')}:</b> ${bdi(x.progress)}</span>`);
  if (x.homework) lines.push(html`<span class="note"><b>${f.t('homework')}:</b> ${bdi(x.homework)}</span>`);
  if (x.comment) lines.push(html`<span class="note"><b>${f.t('comment')}:</b> ${bdi(x.comment)}</span>`);
  return lines.length ? html`${lines}` : html`<span class="faint">—</span>`;
}

// ───────── Students (all) ─────────

export function studentsPdf(f: Fmt, brand: Brand, r: StudentsReport): Rendered {
  const title = f.t('students.title');
  const s = r.summary;
  const body = html`
    ${hero(f, brand, { kind: f.t('students.kind'), title, subtitle: f.t('students.subtitle'), chips: chips(f, r) })}
    ${kpis(
      [
        { label: f.t('studentsCount'), value: f.number(s.students), sub: f.t('activeInPeriod', { n: f.number(s.active) }) },
        { label: f.t('attendanceRate'), value: f.percent(s.attendanceRate), accent: rateColor(s.attendanceRate), sub: f.t('attendedOf', { a: f.number(s.counts.PRESENT + s.counts.LATE), n: f.number(s.counts.PRESENT + s.counts.LATE + s.counts.ABSENT) }) },
        { label: f.t('averageRating'), value: ratingText(f, s.averageRating), accent: '#0ea5e9' },
        { label: f.t('examAverage'), value: f.score(s.examAverage), accent: '#10b981' },
        { label: f.t('needsAttention'), value: f.number(s.flagged), accent: s.flagged ? '#e11d48' : '#10b981', sub: f.t('studentsFlagged') },
      ],
      true,
    )}
    ${section(
      f.t('students.list'),
      r.students.length
        ? table(
            [f.t('studentCol'), f.t('grade'), { label: f.t('held'), c: true }, { label: f.t('outcome.PRESENT'), c: true }, { label: f.t('outcome.LATE'), c: true }, { label: f.t('outcome.ABSENT'), c: true }, { label: f.t('outcome.EXCUSED'), c: true }, f.t('attendanceRate'), { label: f.t('rating'), c: true }, { label: f.t('examAverage'), c: true }, f.t('followUp')],
            r.students.map(
              (x) => html`<tr>
                <td class="strong">${bdi(x.name)}</td><td>${x.grade ? bdi(x.grade) : '—'}</td>
                <td class="c num">${f.number(x.held)}</td><td class="c num">${f.number(x.counts.PRESENT)}</td><td class="c num">${f.number(x.counts.LATE)}</td><td class="c num">${f.number(x.counts.ABSENT)}</td><td class="c num">${f.number(x.counts.EXCUSED)}</td>
                <td style="width:16%">${meter(x.attendanceRate, f.percent(x.attendanceRate), { color: rateColor(x.attendanceRate) })}</td>
                <td class="c num">${ratingText(f, x.averageRating)}</td><td class="c num">${f.score(x.examAverage)}</td>
                <td>${x.flags.length ? flags(f, x.flags) : html`<span class="faint">—</span>`}</td>
              </tr>`,
            ),
          )
        : empty(f.t('noStudents')),
    )}
    ${signoff(f, reference('students', 'all', r), r.generatedAt, [f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('students.file')}-${r.period.from}`, true);
}

// ───────── Register ─────────

/** Columns per table, so a long register wraps into several blocks across the landscape page. */
const REGISTER_COLUMNS = 22;

export function registerPdf(f: Fmt, brand: Brand, r: RegisterReport): Rendered {
  const title = f.t('register.title');
  const blocks: Html[] = [];
  for (let start = 0; start < Math.max(1, r.sessions.length); start += REGISTER_COLUMNS) {
    const cols = r.sessions.slice(start, start + REGISTER_COLUMNS);
    const last = start + REGISTER_COLUMNS >= r.sessions.length;
    blocks.push(html`<div class="table register keep" style="margin-top:${start ? 10 : 0}px"><table>
      <thead><tr>
        <th>${f.t('studentCol')}</th>
        ${cols.map((c) => html`<th class="s"><span class="num">${f.dayMonth(c.day)}</span><br><span class="faint">${f.weekday(c.day)}</span>${c.status === 'CANCELED' || c.status === 'MISSED' ? html`<br><span style="color:#be123c">${f.t(`status.${c.status}`)}</span>` : ''}</th>`)}
        ${last ? html`<th class="c">${f.t('outcome.PRESENT')}</th><th class="c">${f.t('outcome.ABSENT')}</th><th class="c">${f.t('attendanceRate')}</th>` : ''}
      </tr></thead>
      <tbody>${r.students.map(
        (s) => html`<tr>
          <td class="name">${bdi(s.name)}</td>
          ${s.cells.slice(start, start + REGISTER_COLUMNS).map((o) => html`<td class="s">${o ? html`<span class="mark-o" style="background:${OUTCOME_COLORS[o]};${o === 'UNRECORDED' || o === 'CANCELED' || o === 'UPCOMING' ? `color:${COLORS.muted}` : ''}">${f.t(`letter.${o}`)}</span>` : html`<span class="faint">·</span>`}</td>`)}
          ${last ? html`<td class="c num">${f.number(s.counts.PRESENT + s.counts.LATE)}</td><td class="c num">${f.number(s.counts.ABSENT)}</td><td class="c num strong" style="color:${rateColor(s.attendanceRate)}">${f.percent(s.attendanceRate)}</td>` : ''}
        </tr>`,
      )}</tbody>
      <tfoot><tr><td>${f.t('attendedRow')}</td>${cols.map((c) => html`<td class="s num">${c.status === 'COMPLETED' || c.status === 'LIVE' ? f.number(c.counts.PRESENT + c.counts.LATE) : '—'}</td>`)}${last ? html`<td colspan="3"></td>` : ''}</tr></tfoot>
    </table></div>`);
  }

  const s = r.summary;
  const body = html`
    ${hero(f, brand, { kind: f.t('register.kind'), title, subtitle: f.t('register.subtitle'), chips: chips(f, r) })}
    ${kpis([
      { label: f.t('sessionsCol'), value: f.number(s.sessions) },
      { label: f.t('studentsCount'), value: f.number(s.students), accent: '#0ea5e9' },
      { label: f.t('attendanceRate'), value: f.percent(s.attendanceRate), accent: rateColor(s.attendanceRate) },
      { label: f.t('outcome.ABSENT'), value: f.number(s.counts.ABSENT), sub: f.t('excusedCount', { n: f.number(s.counts.EXCUSED) }), accent: '#e11d48' },
    ])}
    ${section(
      f.t('register.grid'),
      r.sessions.length ? html`${blocks}<div style="margin-top:6px" class="legend">${OUTCOMES.filter((o) => o !== 'MISSED').map((o) => html`<span><i style="background:${OUTCOME_COLORS[o]}"></i><b>${f.t(`letter.${o}`)}</b> ${f.t(`outcome.${o}`)}</span>`)}</div>` : empty(f.t('noSessions')),
    )}
    ${signoff(f, reference('register', r.filters.course?.id ?? r.filters.teacher?.id ?? 'all', r), r.generatedAt, [f.t('sign.teacher'), f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('register.file')}-${r.filters.course?.title ?? r.filters.teacher?.name ?? brand.center}-${r.period.from}`, true);
}

// ───────── Teacher ─────────

export function teacherPdf(f: Fmt, brand: Brand, r: TeacherReport): Rendered {
  const title = f.t('teacher.title');
  const s = r.summary;
  const trendPoints: BarPoint[] = r.trend.points.map((p) => ({
    label: r.trend.unit === 'month' ? f.month(p.from) : f.dayMonth(p.from),
    segments: [{ value: p.sessions, color: COLORS.primary }],
    top: p.sessions ? f.number(p.sessions) : undefined,
  }));

  const body = html`
    ${hero(f, brand, { kind: f.t('teacher.kind'), title, subtitle: f.t('teacher.subtitle'), chips: chips(f, { ...r, filters: { ...r.filters, teacher: null } }) })}
    ${subject(r.teacher.name, [
      [f.t('email'), html`<span class="ltr">${r.teacher.email}</span>`],
      [f.t('phone'), r.teacher.phone ? html`<span class="ltr">${r.teacher.phone}</span>` : null],
      [f.t('subjects'), r.teacher.subjects.length ? html`${r.teacher.subjects.map((x, i) => html`${i ? f.t('sep') : ''}${bdi(x)}`)}` : null],
      [f.t('linkedStudents'), f.number(r.teacher.linkedStudents)],
      [f.t('coursesCount'), f.number(r.teacher.courses)],
    ])}
    ${kpis(
      [
        { label: f.t('heldSessions'), value: f.number(s.held), sub: f.t('heldSub', { canceled: f.number(s.canceled), missed: f.number(s.missed), upcoming: f.number(s.upcoming) }) },
        { label: f.t('teachingTime'), value: f.duration(s.heldMinutes), sub: s.actualMinutes === null ? undefined : f.t('actualTime', { time: f.duration(s.actualMinutes) }), accent: '#0ea5e9' },
        { label: f.t('onTime'), value: f.percent(s.onTimeRate), sub: s.averageDelay === null ? f.t('startsRecorded', { n: f.number(s.startsRecorded) }) : f.t('averageDelay', { m: f.number(s.averageDelay) }), accent: COLORS.amber },
        { label: f.t('evaluationRate'), value: f.percent(s.evaluationRate), sub: f.t('evaluatedOf', { a: f.number(s.evaluated), n: f.number(s.evaluationsDue) }), accent: s.evaluationRate !== null && s.evaluationRate < 1 ? '#e11d48' : '#10b981' },
        { label: f.t('studentsAttendance'), value: f.percent(s.attendanceRate), sub: html`${f.t('studentsCountShort', { n: f.number(s.students) })} · ${ratingText(f, s.averageRating)}`, accent: rateColor(s.attendanceRate) },
      ],
      true,
    )}
    ${r.pay
      ? section(
          f.t('pay'),
          kpis([
            { label: f.t('chargedSessions'), value: f.number(r.pay.sessions) },
            { label: f.t('chargedTime'), value: f.duration(r.pay.minutes), accent: '#0ea5e9' },
            { label: f.t('teacherPay'), value: f.money(r.pay.teacherPay, r.pay.currency), accent: '#10b981' },
            ...('fees' in r.pay && r.pay.fees !== undefined ? [{ label: f.t('studentFees'), value: f.money(r.pay.fees, r.pay.currency), accent: COLORS.amber }] : []),
          ]),
          { keep: true },
        )
      : ''}
    ${r.trend.points.length > 1 ? section(f.t('sessionsTrend'), html`<div class="card keep">${columns(f, trendPoints, { height: 130 })}</div>`, { hint: trendHint(f, r.trend.unit), keep: true }) : ''}
    ${section(
      f.t('students.list'),
      r.students.length
        ? table(
            [f.t('studentCol'), { label: f.t('held'), c: true }, { label: f.t('outcome.PRESENT'), c: true }, { label: f.t('outcome.LATE'), c: true }, { label: f.t('outcome.ABSENT'), c: true }, { label: f.t('outcome.EXCUSED'), c: true }, f.t('attendanceRate'), { label: f.t('rating'), c: true }],
            r.students.map(
              (x) => html`<tr><td class="strong">${bdi(x.name)}</td><td class="c num">${f.number(x.held)}</td><td class="c num">${f.number(x.counts.PRESENT)}</td><td class="c num">${f.number(x.counts.LATE)}</td><td class="c num">${f.number(x.counts.ABSENT)}</td><td class="c num">${f.number(x.counts.EXCUSED)}</td><td style="width:24%">${meter(x.attendanceRate, f.percent(x.attendanceRate), { color: rateColor(x.attendanceRate) })}</td><td class="c num">${ratingText(f, x.averageRating)}</td></tr>`,
            ),
          )
        : empty(f.t('noStudents')),
    )}
    ${r.courses.length ? section(f.t('byCourse'), courseRows(f, r.courses)) : ''}
    ${section(
      f.t('sessionLog'),
      r.sessions.length
        ? table(
            ['#', f.t('date'), f.t('session'), f.t('statusCol'), { label: f.t('time'), c: true }, { label: f.t('delay'), c: true }, { label: f.t('attendanceShort'), c: true }, { label: f.t('evaluation'), c: true }],
            r.sessions.map(
              (x, i) => html`<tr>
                <td class="num faint">${f.number(i + 1)}</td>
                <td class="nowrap"><span class="strong">${f.dayShort(x.startAt)}</span><span class="note num">${f.time(x.startAt)}</span></td>
                <td><bdi class="strong">${x.title}</bdi>${x.course ? html`<span class="note">${bdi(x.course.title)}</span>` : ''}</td>
                <td><span class="pill o-${statusTone(x.status)}">${f.t(`status.${x.status}`)}</span></td>
                <td class="c num nowrap">${f.duration(x.minutes)}${x.actualMinutes !== null ? html`<span class="note">${f.t('actualShort', { time: f.duration(x.actualMinutes) })}</span>` : ''}</td>
                <td class="c num">${x.delay === null ? '—' : x.delay <= 5 ? html`<span style="color:${COLORS.success}">${f.t('onTimeShort')}</span>` : html`<span style="color:${COLORS.warning}">${f.t('minutesLate', { m: f.number(x.delay) })}</span>`}</td>
                <td class="c num nowrap">${x.students ? f.t('outOf', { a: f.number(x.counts.PRESENT + x.counts.LATE), n: f.number(x.students) }) : '—'}</td>
                <td class="c">${x.evaluated === null ? '—' : x.evaluated ? html`<span style="color:${COLORS.success}">✓</span>` : html`<span style="color:${COLORS.danger}">${f.t('pending')}</span>`}</td>
              </tr>`,
            ),
          )
        : empty(f.t('noSessions')),
      { hint: f.t('sessionsCount', { n: f.number(r.sessions.length) }) },
    )}
    ${r.exams.length ? section(f.t('exams'), examRows(f, r.exams)) : ''}
    ${signoff(f, reference('teacher', r.teacher.id, r), r.generatedAt, [f.t('sign.teacher'), f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('teacher.file')}-${r.teacher.name}-${r.period.from}`);
}

const statusTone = (s: string): Outcome => (s === 'COMPLETED' ? 'PRESENT' : s === 'LIVE' ? 'LATE' : s === 'SCHEDULED' ? 'UPCOMING' : s === 'MISSED' ? 'ABSENT' : 'CANCELED');

function courseRows(f: Fmt, list: { id: string | null; title: string | null; held: number; heldMinutes: number; students: number; attendanceRate: number | null; averageRating: number | null; canceled: number }[]) {
  return table(
    [f.t('course'), { label: f.t('held'), c: true }, { label: f.t('time'), c: true }, { label: f.t('studentsCountCol'), c: true }, { label: f.t('status.CANCELED'), c: true }, f.t('attendanceRate'), { label: f.t('rating'), c: true }],
    list.map(
      (c) => html`<tr><td class="strong">${c.title ? bdi(c.title) : f.t('noCourse')}</td><td class="c num">${f.number(c.held)}</td><td class="c num">${f.duration(c.heldMinutes)}</td><td class="c num">${f.number(c.students)}</td><td class="c num">${f.number(c.canceled)}</td><td style="width:24%">${meter(c.attendanceRate, f.percent(c.attendanceRate), { color: rateColor(c.attendanceRate) })}</td><td class="c num">${ratingText(f, c.averageRating)}</td></tr>`,
    ),
  );
}

function examRows(f: Fmt, list: { title: string; course: { title: string }; month: string; results: number; average: number | null; highest: number | null; lowest: number | null; distribution: number[] }[]) {
  const bandColors = ['#e11d48', '#f59e0b', '#a5b4fc', '#6366f1', '#10b981'];
  return html`${table(
    [f.t('exam'), f.t('course'), f.t('month'), { label: f.t('results'), c: true }, f.t('average'), { label: f.t('highest'), c: true }, { label: f.t('lowest'), c: true }, f.t('distribution')],
    list.map((e) => {
      const total = e.distribution.reduce((a, b) => a + b, 0) || 1;
      return html`<tr>
        <td class="strong">${bdi(e.title)}</td><td>${bdi(e.course.title)}</td><td class="nowrap">${f.month(e.month)}</td>
        <td class="c num">${f.number(e.results)}</td>
        <td style="width:17%">${meter(e.average, f.score(e.average), { max: 100 })}</td>
        <td class="c num">${f.score(e.highest)}</td><td class="c num">${f.score(e.lowest)}</td>
        <td style="width:16%"><div style="display:flex;height:8px;border-radius:999px;overflow:hidden;background:#eef0f5">${e.distribution.map((n, i) => (n ? html`<span style="width:${((n / total) * 100).toFixed(1)}%;background:${bandColors[i]}"></span>` : ''))}</div></td>
      </tr>`;
    }),
  )}<div class="legend" style="margin-top:5px">${[0, 1, 2, 3, 4].map((i) => html`<span><i style="background:${bandColors[i]}"></i>${f.t(`band.${i as 0 | 1 | 2 | 3 | 4}`)}</span>`)}</div>`;
}

// ───────── Course ─────────

export function coursePdf(f: Fmt, brand: Brand, r: CourseReport): Rendered {
  const title = f.t('course.title');
  const s = r.summary;
  const c = r.course;
  const body = html`
    ${hero(f, brand, { kind: f.t('course.kind'), title, subtitle: f.t('course.subtitle'), chips: chips(f, { ...r, filters: { ...r.filters, course: null } }) })}
    ${subject(c.title, [
      [f.t('teacher'), bdi(c.teacher.name)],
      [f.t('subjectCol'), c.subject ? bdi(c.subject) : null],
      [f.t('level'), c.level ? bdi(c.level) : null],
      [f.t('enrolled'), f.t('enrollments', { active: f.number(c.enrollments.active), completed: f.number(c.enrollments.completed), dropped: f.number(c.enrollments.dropped) })],
    ], c.isActive ? undefined : html`<span class="flag warn">${f.t('inactiveCourse')}</span>`)}
    ${kpis(
      [
        { label: f.t('heldSessions'), value: f.number(s.held), sub: f.t('heldSub', { canceled: f.number(s.canceled), missed: f.number(s.missed), upcoming: f.number(s.upcoming) }) },
        { label: f.t('teachingTime'), value: f.duration(s.heldMinutes), accent: '#0ea5e9' },
        { label: f.t('attendanceRate'), value: f.percent(s.attendanceRate), accent: rateColor(s.attendanceRate), sub: f.t('studentsCountShort', { n: f.number(s.students) }) },
        { label: f.t('averageRating'), value: ratingText(f, s.averageRating), accent: COLORS.amber },
        { label: f.t('examAverage'), value: f.score(s.examAverage), sub: f.t('resultsCount', { n: f.number(s.examResults) }), accent: '#10b981' },
      ],
      true,
    )}
    ${r.trend.points.length > 1 ? section(f.t('trend'), attendanceTrend(f, r.trend), { hint: trendHint(f, r.trend.unit), keep: true }) : ''}
    ${section(
      f.t('students.list'),
      r.students.length
        ? table(
            [f.t('studentCol'), f.t('enrollment'), { label: f.t('held'), c: true }, { label: f.t('outcome.ABSENT'), c: true }, f.t('attendanceRate'), { label: f.t('rating'), c: true }, { label: f.t('examAverage'), c: true }, f.t('followUp')],
            r.students.map(
              (x) => html`<tr><td class="strong">${bdi(x.name)}</td><td>${x.enrollment ? f.t(`enrollmentStatus.${x.enrollment}`) : html`<span class="faint">${f.t('notEnrolled')}</span>`}</td><td class="c num">${f.number(x.held)}</td><td class="c num">${f.number(x.counts.ABSENT)}</td><td style="width:20%">${meter(x.attendanceRate, f.percent(x.attendanceRate), { color: rateColor(x.attendanceRate) })}</td><td class="c num">${ratingText(f, x.averageRating)}</td><td class="c num">${f.score(x.examAverage)}</td><td>${x.flags.length ? flags(f, x.flags) : html`<span class="faint">—</span>`}</td></tr>`,
            ),
          )
        : empty(f.t('noStudents')),
    )}
    ${section(
      f.t('sessionLog'),
      r.sessions.length
        ? table(
            ['#', f.t('date'), f.t('session'), f.t('statusCol'), { label: f.t('outcome.PRESENT'), c: true }, { label: f.t('outcome.LATE'), c: true }, { label: f.t('outcome.ABSENT'), c: true }, { label: f.t('outcome.EXCUSED'), c: true }, f.t('attendanceRate')],
            r.sessions.map(
              (x, i) => html`<tr><td class="num faint">${f.number(i + 1)}</td><td class="nowrap"><span class="strong">${f.dayShort(x.startAt)}</span><span class="note num">${f.time(x.startAt)}</span></td><td><bdi class="strong">${x.title}</bdi></td><td><span class="pill o-${statusTone(x.status)}">${f.t(`status.${x.status}`)}</span></td><td class="c num">${f.number(x.counts.PRESENT)}</td><td class="c num">${f.number(x.counts.LATE)}</td><td class="c num">${f.number(x.counts.ABSENT)}</td><td class="c num">${f.number(x.counts.EXCUSED)}</td><td style="width:20%">${meter(x.attendanceRate, f.percent(x.attendanceRate), { color: rateColor(x.attendanceRate) })}</td></tr>`,
            ),
          )
        : empty(f.t('noSessions')),
    )}
    ${section(f.t('exams'), r.exams.length ? examRows(f, r.exams) : empty(f.t('noExams')))}
    ${signoff(f, reference('course', c.id, r), r.generatedAt, [f.t('sign.teacher'), f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('course.file')}-${c.title}-${r.period.from}`);
}

// ───────── Center ─────────

export function centerPdf(f: Fmt, brand: Brand, r: CenterReport): Rendered {
  const title = f.t('center.title');
  const k = r.kpis;
  const p = r.previousKpis;
  const fin = r.finance;
  const pf = r.previousFinance;
  const vsPrev = f.t('vsPrevious', { period: f.period(r.previous.from, r.previous.to) });

  const body = html`
    ${hero(f, brand, { kind: f.t('center.kind'), title, subtitle: f.t('center.subtitle'), chips: chips(f, r) })}
    <div class="small muted" style="margin-top:8px">${vsPrev}</div>
    ${kpis(
      [
        { label: f.t('activeStudents'), value: f.number(k.activeStudents), sub: html`${f.t('ofStudents', { n: f.number(k.students), added: f.number(k.newStudents) })} ${delta(f, k.activeStudents, p.activeStudents, 'number')}` },
        { label: f.t('heldSessions'), value: f.number(k.held), sub: html`${f.t('heldSub', { canceled: f.number(k.canceled), missed: f.number(k.missed), upcoming: f.number(k.upcoming) })}`, accent: '#0ea5e9' },
        { label: f.t('teachingTime'), value: f.duration(k.heldMinutes), sub: delta(f, k.heldMinutes, p.heldMinutes, 'relative'), accent: '#6366f1' },
        { label: f.t('attendanceRate'), value: f.percent(k.attendanceRate), sub: delta(f, k.attendanceRate, p.attendanceRate, 'rate'), accent: rateColor(k.attendanceRate) },
        { label: f.t('examAverage'), value: f.score(k.examAverage), sub: delta(f, k.examAverage, p.examAverage, 'points'), accent: '#10b981' },
      ],
      true,
    )}
    ${kpis(
      [
        { label: f.t('averageRating'), value: ratingText(f, k.averageRating), sub: delta(f, k.averageRating, p.averageRating, 'points'), accent: COLORS.amber },
        { label: f.t('onTime'), value: f.percent(k.onTimeRate), sub: delta(f, k.onTimeRate, p.onTimeRate, 'rate'), accent: COLORS.amber },
        { label: f.t('evaluationRate'), value: f.percent(k.evaluationRate), sub: f.t('evaluatedOf', { a: f.number(k.evaluated), n: f.number(k.evaluationsDue) }), accent: k.evaluationRate !== null && k.evaluationRate < 1 ? '#e11d48' : '#10b981' },
        { label: f.t('activeTeachers'), value: f.number(k.activeTeachers), sub: f.t('ofTeachers', { n: f.number(k.teachers) }), accent: COLORS.primary },
        { label: f.t('needsAttention'), value: f.number(k.flaggedStudents), sub: f.t('studentsFlagged'), accent: k.flaggedStudents ? '#e11d48' : '#10b981' },
      ],
      true,
    )}
    ${fin
      ? section(
          f.t('finance'),
          kpis([
            { label: f.t('studentFees'), value: f.money(fin.fees, fin.currency), sub: delta(f, fin.fees, pf?.fees, 'relative'), accent: '#10b981' },
            { label: f.t('teacherPay'), value: f.money(fin.teacherPay, fin.currency), sub: delta(f, fin.teacherPay, pf?.teacherPay, 'relative', 'down'), accent: COLORS.amber },
            { label: f.t('platformFee'), value: fin.platformFee === null ? '—' : f.money(fin.platformFee, fin.currency), accent: '#94a3b8' },
            { label: f.t('net'), value: fin.net === null ? '—' : f.money(fin.net, fin.currency), sub: delta(f, fin.net, pf?.net ?? null, 'relative'), accent: COLORS.primary },
          ]),
          { keep: true, hint: fin.missingRates ? f.t('missingRates', { n: f.number(fin.missingRates) }) : undefined },
        )
      : ''}
    ${r.trend.points.length > 1 ? section(f.t('trend'), attendanceTrend(f, r.trend), { hint: trendHint(f, r.trend.unit), keep: true }) : ''}
    ${section(
      f.t('teachersPerformance'),
      r.teachers.length
        ? table(
            [f.t('teacher'), { label: f.t('held'), c: true }, { label: f.t('time'), c: true }, { label: f.t('status.CANCELED'), c: true }, { label: f.t('status.MISSED'), c: true }, { label: f.t('onTime'), c: true }, { label: f.t('evaluationRate'), c: true }, f.t('studentsAttendance'), { label: f.t('rating'), c: true }],
            r.teachers.map(
              (t) => html`<tr><td class="strong">${bdi(t.name)}</td><td class="c num">${f.number(t.held)}</td><td class="c num">${f.duration(t.heldMinutes)}</td><td class="c num">${f.number(t.canceled)}</td><td class="c num">${f.number(t.missed)}</td><td class="c num">${f.percent(t.onTimeRate)}</td><td class="c num">${f.percent(t.evaluationRate)}</td><td style="width:18%">${meter(t.attendanceRate, f.percent(t.attendanceRate), { color: rateColor(t.attendanceRate) })}</td><td class="c num">${ratingText(f, t.averageRating)}</td></tr>`,
            ),
          )
        : empty(f.t('noSessions')),
    )}
    ${r.courses.length ? section(f.t('byCourse'), courseRows(f, r.courses)) : ''}
    ${section(
      f.t('atRisk'),
      r.atRisk.length
        ? table(
            [f.t('studentCol'), f.t('attendanceRate'), { label: f.t('absenceStreak'), c: true }, { label: f.t('examAverage'), c: true }, f.t('followUp')],
            r.atRisk.map(
              (x) => html`<tr><td class="strong">${bdi(x.name)}</td><td style="width:22%">${meter(x.attendanceRate, f.percent(x.attendanceRate), { color: rateColor(x.attendanceRate) })}</td><td class="c num">${f.number(x.streak)}</td><td class="c num">${f.score(x.examAverage)}</td><td>${flags(f, x.flags)}</td></tr>`,
            ),
          )
        : empty(f.t('noRisk')),
      { keep: true },
    )}
    ${signoff(f, reference('center', 'center', r), r.generatedAt, [f.t('sign.center')])}
  `;
  return finish(f, brand, title, body, `${f.t('center.file')}-${r.period.from}-${r.period.to}`);
}
