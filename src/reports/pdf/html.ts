/**
 * A tiny HTML builder for the report templates: every interpolated value is escaped unless it is
 * already markup made by `html` (or a list of it), so names and notes typed by users can't inject
 * anything into the document.
 */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

function part(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  values.forEach((v, i) => {
    out += part(v) + strings[i + 1];
  });
  return new Html(out);
}

/** Trusted markup (CSS, inline SVG built here, data URIs). */
export const raw = (value: string) => new Html(value);

/** User text: isolated, so Arabic names keep their order inside English sentences and the reverse. */
export const bdi = (v: unknown) => html`<bdi>${v}</bdi>`;
