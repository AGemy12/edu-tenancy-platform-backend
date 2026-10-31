import { describe, expect, it } from 'vitest';
import { bdi, html, raw } from './html.js';
import { formatter } from './format.js';

describe('html', () => {
  it('escapes interpolated user text', () => {
    const name = '<img src=x onerror="alert(1)">';
    expect(html`<td>${name}</td>`.value).toBe('<td>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</td>');
  });

  it('keeps markup it built, joins lists and drops empty values', () => {
    const rows = ['a', '<b>'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${rows}${null}${false}${undefined}</ul>${raw('<hr>')}`.value).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul><hr>');
  });

  it('isolates user text', () => {
    expect(bdi("O'Neil").value).toBe('<bdi>O&#39;Neil</bdi>');
  });
});

describe('formatter', () => {
  it("writes moments in the center's time zone with Latin digits", () => {
    const ar = formatter('ar', 'Africa/Cairo');
    expect(ar.time('2026-10-04T14:00:00Z')).toMatch(/^5:00/);
    expect(ar.number(1234.5)).toBe('1,234.5');
    expect(formatter('en', 'Africa/Cairo').duration(150)).toBe('2 h 30 min');
  });
});
