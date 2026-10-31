import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** The platform's font (the web app's too), weights the reports use. */
const FONT_PACKAGE = '@fontsource/ibm-plex-sans-arabic';
const WEIGHTS = [400, 500, 600, 700];
const SUBSETS = ['arabic', 'latin', 'latin-ext'];

let fontCss: string | null = null;

/**
 * @font-face rules with the font files inlined as data URIs: the renderer blocks every network
 * request, and the PDF must look the same on any server.
 */
export function fontFaces() {
  if (fontCss !== null) return fontCss;
  const dir = path.dirname(require.resolve(`${FONT_PACKAGE}/files/ibm-plex-sans-arabic-arabic-400-normal.woff2`));
  const rules: string[] = [];
  for (const weight of WEIGHTS) {
    const css = readFileSync(path.join(dir, '..', `${weight}.css`), 'utf8');
    for (const block of css.split('@font-face').slice(1)) {
      const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
      if (!file || !SUBSETS.some((s) => file.includes(`-${s}-${weight}-`))) continue;
      const data = readFileSync(path.join(dir, file)).toString('base64');
      rules.push(
        `@font-face{font-family:'Plex';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range};}`,
      );
    }
  }
  fontCss = rules.join('\n');
  return fontCss;
}

/** The platform's colors (frontend globals.css, light theme). */
export const COLORS = {
  primary: '#4338ca',
  primaryDeep: '#312e81',
  primarySoft: '#ecebfa',
  ink: '#0f172a',
  muted: '#5b6475',
  faint: '#8a93a6',
  line: '#e3e6ee',
  soft: '#f5f6fa',
  success: '#047857',
  warning: '#b45309',
  danger: '#be123c',
  info: '#0369a1',
  amber: '#f59e0b',
};

/** One color per seat outcome, shared by pills, charts and the calendar. */
export const OUTCOME_COLORS = {
  PRESENT: '#10b981',
  LATE: '#f59e0b',
  EXCUSED: '#0ea5e9',
  ABSENT: '#e11d48',
  UNRECORDED: '#cbd5e1',
  UPCOMING: '#a5b4fc',
  CANCELED: '#e2e8f0',
  MISSED: '#94a3b8',
} as const;

export const STYLES = `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'Plex','Segoe UI',Tahoma,Arial,sans-serif;font-size:8.6pt;line-height:1.55;color:${COLORS.ink};background:#fff}
bdi{unicode-bidi:isolate}
.num{font-variant-numeric:tabular-nums}
.muted{color:${COLORS.muted}}
.faint{color:${COLORS.faint}}
.small{font-size:7.4pt}
.strong{font-weight:600}
.ltr{direction:ltr;unicode-bidi:isolate}
.nowrap{white-space:nowrap}

/* ── Cover band ── */
.hero{position:relative;overflow:hidden;border-radius:18px;padding:16px 22px 18px;color:#fff;
  background:linear-gradient(118deg,#1e1b4b 0%,#312e81 30%,#4338ca 68%,#6366f1 100%)}
.hero .dots{position:absolute;inset:0;opacity:.18;background-image:radial-gradient(rgba(255,255,255,.55) 1px,transparent 1.2px);background-size:13px 13px}
.hero .glow{position:absolute;border-radius:50%}
.hero .g1{width:260px;height:260px;inset-inline-end:-80px;top:-120px;background:radial-gradient(circle,rgba(165,180,252,.55),transparent 68%)}
.hero .g2{width:200px;height:200px;inset-inline-start:30%;bottom:-150px;background:radial-gradient(circle,rgba(245,158,11,.32),transparent 70%)}
.hero-top,.hero-main{position:relative;display:flex;justify-content:space-between;align-items:center;gap:16px}
.hero-main{margin-top:14px;align-items:flex-end}
.brand{display:flex;align-items:center;gap:8px;font-size:8.2pt;font-weight:600;color:rgba(255,255,255,.95)}
.brand .mark{width:24px;height:24px;border-radius:7px;background:#fff;color:${COLORS.primary};display:flex;align-items:center;justify-content:center}
.brand .mark svg{width:15px;height:15px}
.kind{font-size:7.4pt;padding:3px 11px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);font-weight:500}
.hero h1{margin:0;font-size:20pt;line-height:1.25;font-weight:700;letter-spacing:-.2px}
.hero .subtitle{margin-top:2px;font-size:9.6pt;color:rgba(255,255,255,.86)}
.hero .chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.hero .chip{font-size:7.5pt;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:2px 10px}
.org{display:flex;align-items:center;gap:10px;flex-shrink:0}
.org .who{text-align:end}
.org .name{font-weight:700;font-size:10.5pt;line-height:1.3}
.org .meta{font-size:7.2pt;color:rgba(255,255,255,.78)}
.org .logo{width:56px;height:56px;border-radius:15px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 6px 16px rgba(15,23,42,.28)}
.org .logo img{max-width:48px;max-height:48px;object-fit:contain}
.org .logo .initial{font-size:21pt;font-weight:700;color:${COLORS.primary}}

/* ── Subject card ── */
.subject{margin-top:11px;display:flex;align-items:center;gap:14px;padding:11px 16px;border:1px solid ${COLORS.line};border-radius:14px;background:#fff}
.avatar{width:42px;height:42px;flex-shrink:0;border-radius:50%;background:${COLORS.primarySoft};color:#3730a3;font-weight:700;font-size:15pt;display:flex;align-items:center;justify-content:center}
.subject .name{font-size:13.5pt;font-weight:700;line-height:1.3}
.facts{display:flex;flex-wrap:wrap;gap:2px 16px;font-size:7.8pt;color:${COLORS.muted};margin-top:2px}
.facts b{color:${COLORS.ink};font-weight:600}
.subject .side{margin-inline-start:auto;text-align:end}

/* ── KPI tiles ── */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:11px}
.kpis.five{grid-template-columns:repeat(5,1fr)}
.kpi{position:relative;overflow:hidden;border:1px solid ${COLORS.line};border-radius:12px;padding:9px 12px 8px;background:#fff;break-inside:avoid}
.kpi::before{content:'';position:absolute;top:0;bottom:0;inset-inline-start:0;width:3px;background:var(--accent,${COLORS.primary})}
.kpi .label{font-size:7.4pt;color:${COLORS.muted};font-weight:500}
.kpi .value{font-size:15.5pt;font-weight:700;line-height:1.25;margin-top:1px}
.kpi .sub{font-size:7.1pt;color:${COLORS.muted};display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.delta{font-size:6.9pt;font-weight:600;padding:0 6px;border-radius:999px;white-space:nowrap}
.delta.up{color:${COLORS.success};background:#e7f6ef}
.delta.down{color:${COLORS.danger};background:#fdecef}
.delta.flat{color:${COLORS.muted};background:#f1f3f8}

/* ── Sections ── */
.section{margin-top:15px}
.section>h2{font-size:10.6pt;margin:0 0 7px;display:flex;align-items:center;gap:8px;font-weight:700;break-after:avoid}
.section>h2::before{content:'';width:8px;height:8px;border-radius:3px;background:${COLORS.primary};box-shadow:0 0 0 3px ${COLORS.primarySoft};flex-shrink:0}
.section>h2 .hint{margin-inline-start:auto;font-weight:400;font-size:7.6pt;color:${COLORS.muted}}
.keep{break-inside:avoid}
.card{border:1px solid ${COLORS.line};border-radius:14px;background:#fff;padding:12px 14px}
.split{display:grid;grid-template-columns:1fr 1.45fr;gap:10px}
.halves{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.empty{padding:14px;text-align:center;color:${COLORS.faint};border:1px dashed ${COLORS.line};border-radius:12px;font-size:8pt}

/* ── Tables ── */
.table{border:1px solid ${COLORS.line};border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:7.9pt}
thead{display:table-header-group}
tr{break-inside:avoid}
th{background:${COLORS.soft};color:${COLORS.muted};font-weight:600;text-align:start;padding:6px 8px;font-size:7.3pt;border-bottom:1px solid ${COLORS.line};white-space:nowrap}
td{padding:5.5px 8px;border-bottom:1px solid #eef0f5;vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even) td{background:#fafbfd}
td.c,th.c{text-align:center}
tfoot td{background:${COLORS.soft};font-weight:600;border-top:1px solid ${COLORS.line}}
.note{display:block;font-size:7.2pt;color:${COLORS.muted};margin-top:1px}
.note b{color:${COLORS.ink};font-weight:600}

/* ── Pills & legend ── */
.pill{display:inline-block;white-space:nowrap;padding:0 8px;border-radius:999px;font-size:7pt;font-weight:600;line-height:1.7}
.o-PRESENT{background:#e7f6ef;color:#047857}
.o-LATE{background:#fef3e2;color:#b45309}
.o-ABSENT{background:#fdecef;color:#be123c}
.o-EXCUSED{background:#e6f4fb;color:#0369a1}
.o-UNRECORDED{background:#f1f3f8;color:#5b6475}
.o-UPCOMING{background:${COLORS.primarySoft};color:#3730a3}
.o-CANCELED,.o-MISSED{background:#f1f3f8;color:#8a93a6}
.flag{display:inline-block;padding:0 7px;border-radius:6px;font-size:6.9pt;font-weight:600;background:#fdecef;color:${COLORS.danger};margin:1px 0;margin-inline-end:3px;white-space:nowrap}
.flag.warn{background:#fef3e2;color:${COLORS.warning}}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:7.4pt;color:${COLORS.muted}}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2.5px;margin-inline-end:4px;vertical-align:-0.5px}
.legend b{color:${COLORS.ink};font-weight:600}

/* ── Meters ── */
.meter{display:flex;align-items:center;gap:6px}
.bar{position:relative;flex:1;height:6px;border-radius:999px;background:#eef0f5;overflow:hidden;min-width:40px}
.bar>span{position:absolute;top:0;bottom:0;inset-inline-start:0;border-radius:999px;background:${COLORS.primary}}
.bar>em{position:absolute;top:-2px;bottom:-2px;width:2px;background:${COLORS.amber};border-radius:2px}
.meter .v{min-width:30px;text-align:end;font-weight:600;font-size:7.6pt}

/* ── Donut ── */
.donut-wrap{display:flex;align-items:center;gap:14px}
.donut{position:relative;width:112px;height:112px;flex-shrink:0}
.donut svg{width:112px;height:112px;transform:rotate(-90deg)}
.donut .mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.donut .mid b{font-size:16pt;line-height:1.1}
.donut .mid span{font-size:6.8pt;color:${COLORS.muted}}
.stack{display:flex;flex-direction:column;gap:5px;font-size:7.8pt;flex:1}
.stack .row{display:flex;align-items:center;gap:6px}
.stack .row i{width:9px;height:9px;border-radius:3px;flex-shrink:0}
.stack .row .n{margin-inline-start:auto;font-weight:600}

/* ── Calendar ── */
.months{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 14px}
.months.one{grid-template-columns:1fr}
.month .title{font-weight:600;font-size:8pt;margin-bottom:4px}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal .wd{font-size:6.3pt;color:${COLORS.faint};text-align:center}
.cal .d{height:21px;border-radius:6px;background:${COLORS.soft};font-size:6.8pt;color:${COLORS.faint};display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.1}
.cal .d.out{background:transparent;color:#d5d9e2}
.cal .d.blank{background:transparent}
.cal .d.has{color:${COLORS.ink};font-weight:600}
.cal .dots{display:flex;gap:2px;margin-top:1px}
.cal .dots i{width:4.5px;height:4.5px;border-radius:50%}

/* ── Charts ── */
.chart svg{width:100%;display:block}
.chart text{font-family:'Plex','Segoe UI',Tahoma,Arial,sans-serif}

/* ── Notes ── */
.quotes{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.quote{border:1px solid ${COLORS.line};border-radius:12px;padding:8px 11px;background:#fff;break-inside:avoid;border-inline-start:3px solid ${COLORS.primary}}
.quote .who{font-size:7pt;color:${COLORS.muted};margin-top:3px}

/* ── Register ── */
.register th.s{padding:4px 2px;text-align:center;font-size:6.2pt;line-height:1.25;white-space:normal;min-width:20px}
.register td.s{padding:3px 1px;text-align:center}
.register td.name{white-space:nowrap;font-weight:600}
.mark-o{display:inline-flex;width:15px;height:15px;border-radius:4px;align-items:center;justify-content:center;font-size:6.6pt;font-weight:700;color:#fff}
.register td{border-inline-start:1px solid #f1f3f8}

/* ── Sign-off ── */
.signoff{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px;break-inside:avoid}
.signoff .box{border:1px dashed #cfd4e0;border-radius:12px;height:64px;padding:7px 12px;font-size:7.6pt;color:${COLORS.muted}}
.issued{margin-top:8px;display:flex;justify-content:space-between;gap:12px;font-size:7pt;color:${COLORS.faint};break-inside:avoid}
`;
