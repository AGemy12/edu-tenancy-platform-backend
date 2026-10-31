import type { Outcome, RiskFlag } from '../report-rules.js';
import type { Fmt } from './format.js';
import { bdi, esc, html, raw, type Html } from './html.js';
import { COLORS, OUTCOME_COLORS, STYLES, fontFaces } from './theme.js';

const CAP_ICON = raw(
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></svg>',
);

/** The first letter of a name, past a short title such as "Dr.". */
const initial = (name: string) => [...name.replace(/^\S{1,3}\.\s*/u, '').trim()][0] ?? '•';

export type Brand = { center: string; timezone: string; logo: string | null };

/** The whole document: fonts, styles, the cover band and the body. */
export function documentHtml(f: Fmt, opts: { title: string; body: Html }) {
  return `<!doctype html><html lang="${f.locale}" dir="${f.dir}"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
<style>${fontFaces()}${STYLES}</style></head><body>${opts.body.value}</body></html>`;
}

/** The cover band: platform brand, report kind, title, subtitle, chips and the center's logo. */
export function hero(f: Fmt, brand: Brand, o: { kind: string; title: string; subtitle?: string; chips?: (string | Html)[] }) {
  return html`<header class="hero">
    <div class="dots"></div><div class="glow g1"></div><div class="glow g2"></div>
    <div class="hero-top">
      <div class="brand"><span class="mark">${CAP_ICON}</span>${f.t('platform')}</div>
      <span class="kind">${o.kind}</span>
    </div>
    <div class="hero-main">
      <div>
        <h1>${bdi(o.title)}</h1>
        ${o.subtitle ? html`<div class="subtitle">${o.subtitle}</div>` : ''}
        ${o.chips?.length ? html`<div class="chips">${o.chips.map((c) => html`<span class="chip">${c}</span>`)}</div>` : ''}
      </div>
      <div class="org">
        <div class="who">
          <div class="name">${bdi(brand.center)}</div>
          <div class="meta">${f.t('timezone', { tz: brand.timezone })}</div>
        </div>
        <div class="logo">${brand.logo ? html`<img src="${raw(brand.logo)}" alt="">` : html`<span class="initial">${initial(brand.center)}</span>`}</div>
      </div>
    </div>
  </header>`;
}

/** Who the report is about. */
export function subject(name: string, facts: [string, string | Html | null | undefined][], side?: Html) {
  return html`<section class="subject keep">
    <div class="avatar">${initial(name)}</div>
    <div>
      <div class="name">${bdi(name)}</div>
      <div class="facts">${facts.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => html`<span>${k}: <b>${v}</b></span>`)}</div>
    </div>
    ${side ? html`<div class="side">${side}</div>` : ''}
  </section>`;
}

export type Tile = { label: string; value: string; sub?: string | Html; accent?: string };

export function kpis(tiles: Tile[], five = false) {
  return html`<section class="kpis${five ? ' five' : ''}">
    ${tiles.map(
      (t) => html`<div class="kpi" style="--accent:${t.accent ?? COLORS.primary}">
        <div class="label">${t.label}</div>
        <div class="value num">${t.value}</div>
        ${t.sub ? html`<div class="sub">${t.sub}</div>` : ''}
      </div>`,
    )}
  </section>`;
}

/**
 * The change from the period before: in percentage points for rates (0..1), in units for scores,
 * ratings and counts, or as a percentage of the earlier value (`relative`, for money and time).
 * `better` says which way is good. Nothing when either side is unknown.
 */
export function delta(
  f: Fmt,
  now: number | null,
  before: number | null | undefined,
  kind: 'rate' | 'points' | 'number' | 'relative',
  better: 'up' | 'down' = 'up',
) {
  if (now === null || before === null || before === undefined) return html``;
  if (kind === 'relative' && before === 0) return html``;
  const diff =
    kind === 'rate' ? Math.round((now - before) * 100) : kind === 'relative' ? Math.round(((now - before) / Math.abs(before)) * 100) : Math.round((now - before) * 10) / 10;
  if (diff === 0) return html`<span class="delta flat">${f.t('noChange')}</span>`;
  const good = better === 'up' ? diff > 0 : diff < 0;
  const value = `${diff > 0 ? '▲ +' : '▼ −'}${f.number(Math.abs(diff))}${kind === 'relative' ? '%' : ''}`;
  return html`<span class="delta ${good ? 'up' : 'down'}"><span class="ltr">${value}</span>${kind === 'rate' ? f.t('pointsSuffix') : ''}</span>`;
}

export function section(title: string, body: Html | Html[], o: { hint?: string; keep?: boolean } = {}) {
  return html`<section class="section${o.keep ? ' keep' : ''}"><h2>${title}${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}</h2>${body}</section>`;
}

export const empty = (text: string) => html`<div class="empty">${text}</div>`;

export function table(head: (string | { label: string; c?: boolean })[], rows: Html[], foot?: Html) {
  return html`<div class="table"><table>
    <thead><tr>${head.map((h) => (typeof h === 'string' ? html`<th>${h}</th>` : html`<th class="${h.c ? 'c' : ''}">${h.label}</th>`))}</tr></thead>
    <tbody>${rows}</tbody>
    ${foot ? html`<tfoot>${foot}</tfoot>` : ''}
  </table></div>`;
}

export const pill = (f: Fmt, o: Outcome) => html`<span class="pill o-${o}">${f.t(`outcome.${o}`)}</span>`;

export function flags(f: Fmt, list: RiskFlag[]) {
  return list.map((x) => html`<span class="flag${x === 'LOW_RATING' || x === 'LOW_SCORES' ? ' warn' : ''}">${f.t(`flag.${x}`)}</span>`);
}

/** A thin bar for a 0..1 (or 0..100) value, with an optional amber marker (e.g. the group average). */
export function meter(value: number | null, label: string, o: { max?: number; marker?: number | null; color?: string } = {}) {
  if (value === null) return html`<span class="faint">—</span>`;
  const max = o.max ?? 1;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const marker = o.marker === null || o.marker === undefined ? null : Math.max(0, Math.min(100, (o.marker / max) * 100));
  return html`<div class="meter"><div class="bar"><span style="width:${pct.toFixed(1)}%;${o.color ? `background:${o.color}` : ''}"></span>${
    marker === null ? '' : html`<em style="inset-inline-start:calc(${marker.toFixed(1)}% - 1px)"></em>`
  }</div><span class="v num">${label}</span></div>`;
}

/** Color of an attendance rate: green from 90%, amber from 75%, red below. */
export const rateColor = (rate: number | null) => (rate === null ? COLORS.faint : rate >= 0.9 ? '#10b981' : rate >= 0.75 ? COLORS.amber : '#e11d48');

const DONUT_ORDER: Outcome[] = ['PRESENT', 'LATE', 'EXCUSED', 'ABSENT', 'UNRECORDED'];

/** The attendance donut with its legend. */
export function attendanceDonut(f: Fmt, counts: Record<Outcome, number>, rate: number | null) {
  const total = DONUT_ORDER.reduce((n, o) => n + counts[o], 0);
  let offset = 0;
  const arcs = DONUT_ORDER.filter((o) => counts[o] > 0).map((o) => {
    const share = (counts[o] / total) * 100;
    const arc = `<circle r="15.915" cx="18" cy="18" fill="none" stroke="${OUTCOME_COLORS[o]}" stroke-width="4.2" stroke-dasharray="${share.toFixed(3)} ${(100 - share).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"/>`;
    offset += share;
    return arc;
  });
  const svg = `<svg viewBox="0 0 36 36"><circle r="15.915" cx="18" cy="18" fill="none" stroke="#eef0f5" stroke-width="4.2"/>${arcs.join('')}</svg>`;
  return html`<div class="donut-wrap">
    <div class="donut">${raw(svg)}<div class="mid"><b class="num">${f.percent(rate)}</b><span>${f.t('attendanceRate')}</span></div></div>
    <div class="stack">
      ${[...DONUT_ORDER, 'CANCELED' as const, 'UPCOMING' as const].map(
        (o) => html`<div class="row"><i style="background:${OUTCOME_COLORS[o]}"></i>${f.t(`outcome.${o}`)}<span class="n num">${f.number(counts[o])}</span></div>`,
      )}
    </div>
  </div>`;
}

export function legend(f: Fmt, outcomes: Outcome[]) {
  return html`<div class="legend">${outcomes.map((o) => html`<span><i style="background:${OUTCOME_COLORS[o]}"></i>${f.t(`outcome.${o}`)}</span>`)}</div>`;
}

/** Month grids of the period with each day's seats as colored dots. Weeks start on Saturday in Arabic, Sunday in English. */
export function calendar(f: Fmt, from: string, to: string, days: { date: string; outcomes: Outcome[] }[]) {
  const byDay = new Map(days.map((d) => [d.date, d.outcomes]));
  const firstWeekday = f.locale === 'ar' ? 6 : 0;
  const months: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = nextMonth(m)) months.push(m);
  const weekdays = Array.from({ length: 7 }, (_, i) => f.weekday(isoOfWeekday((firstWeekday + i) % 7)));

  return html`<div class="months${months.length === 1 ? ' one' : ''}">${months.map((m) => {
    const [y, mo] = m.split('-').map(Number);
    const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() - firstWeekday + 7) % 7;
    const cells: Html[] = Array.from({ length: lead }, () => html`<div class="d blank"></div>`);
    for (let d = 1; d <= count; d++) {
      const date = `${m}-${String(d).padStart(2, '0')}`;
      const list = byDay.get(date) ?? [];
      const out = date < from || date > to;
      const single = list.length === 1 ? list[0] : null;
      const style = single ? `background:${tint(single)};color:${shade(single)}` : '';
      cells.push(
        html`<div class="d${out ? ' out' : ''}${list.length ? ' has' : ''}" style="${style}"><span class="num">${f.number(d)}</span>${
          list.length > 1 ? html`<span class="dots">${list.slice(0, 4).map((o) => html`<i style="background:${OUTCOME_COLORS[o]}"></i>`)}</span>` : ''
        }</div>`,
      );
    }
    return html`<div class="month keep"><div class="title">${f.month(m)}</div><div class="cal">${weekdays.map((w) => html`<div class="wd">${w}</div>`)}${cells}</div></div>`;
  })}</div>`;
}

const TINTS: Record<Outcome, [string, string]> = {
  PRESENT: ['#d9f3e8', '#047857'],
  LATE: ['#fdebcc', '#92400e'],
  EXCUSED: ['#d6eefa', '#0369a1'],
  ABSENT: ['#fbd9e0', '#be123c'],
  UNRECORDED: ['#eceff4', '#5b6475'],
  UPCOMING: ['#e3e2fb', '#3730a3'],
  CANCELED: ['#f1f3f8', '#8a93a6'],
  MISSED: ['#e8ebf1', '#5b6475'],
};
const tint = (o: Outcome) => TINTS[o][0];
const shade = (o: Outcome) => TINTS[o][1];

function nextMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** A Sunday-based weekday as a fixed calendar day (2026-01-04 was a Sunday). */
const isoOfWeekday = (wd: number) => `2026-01-${String(4 + wd).padStart(2, '0')}`;

export type BarPoint = { label: string; segments: { value: number; color: string }[]; top?: string };

/**
 * Stacked columns over time (counts per outcome, or one value), the rate or total written above
 * each. Time runs right to left in Arabic.
 */
export function columns(f: Fmt, points: BarPoint[], o: { height?: number } = {}) {
  if (!points.length) return html``;
  const W = 720;
  const H = o.height ?? 150;
  const top = 18;
  const bottom = 22;
  const plot = H - top - bottom;
  const max = Math.max(1, ...points.map((p) => p.segments.reduce((n, s) => n + s.value, 0)));
  const slot = W / points.length;
  const bw = Math.min(46, slot * 0.58);
  const rtl = f.dir === 'rtl';
  const parts: string[] = [];
  for (let g = 0; g <= 4; g++) {
    const y = top + plot - (plot * g) / 4;
    parts.push(`<line x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${g === 0 ? '#d5d9e2' : '#eef0f5'}" stroke-width="1"/>`);
  }
  points.forEach((p, i) => {
    const cx = (rtl ? points.length - 1 - i : i) * slot + slot / 2;
    let y = top + plot;
    p.segments.forEach((s, si) => {
      if (s.value <= 0) return;
      const h = (s.value / max) * plot;
      y -= h;
      const isTop = p.segments.slice(si + 1).every((x) => x.value <= 0);
      parts.push(
        isTop
          ? `<path d="${roundedTop(cx - bw / 2, y, bw, h, Math.min(5, h))}" fill="${s.color}"/>`
          : `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"/>`,
      );
    });
    if (p.top) parts.push(`<text x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="${COLORS.ink}">${esc(p.top)}</text>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="${COLORS.muted}">${esc(p.label)}</text>`);
  });
  return html`<div class="chart">${raw(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H * 0.75}px">${parts.join('')}</svg>`)}</div>`;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x.toFixed(1)},${(y + h).toFixed(1)} V${(y + r).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} H${(x + w - r).toFixed(1)} Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)} V${(y + h).toFixed(1)} Z`;
}

/** Signature boxes and the issue line closing a report. */
export function signoff(f: Fmt, reference: string, generatedAt: string, boxes: string[]) {
  return html`<section class="signoff" style="grid-template-columns:repeat(${boxes.length},1fr)">${boxes.map((b) => html`<div class="box">${b}</div>`)}</section>
  <div class="issued"><span>${f.t('issuedBy', { platform: f.t('platform') })}</span><span>${f.t('reference')}: <bdi class="strong">${reference}</bdi> · ${f.dateTime(generatedAt)}</span></div>`;
}

/** Chrome's page footer (it can't use the page's fonts or styles, so it's styled inline). */
export function footer(f: Fmt, center: string, title: string) {
  const sep = '<span style="color:#cfd4e0;margin:0 6px">|</span>';
  return `<div dir="${f.dir}" style="width:100%;font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:7px;color:#8a93a6;padding:0 11mm;display:flex;justify-content:space-between;align-items:center">
  <span><span style="color:#4338ca;font-weight:700">${esc(f.t('platform'))}</span>${sep}<bdi>${esc(center)}</bdi>${sep}${esc(title)}</span>
  <span dir="ltr"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;
}
