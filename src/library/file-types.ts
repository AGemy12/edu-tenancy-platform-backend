import type { FileKind } from '../generated/prisma/enums.js';

type TypeInfo = { mime: string; kind: FileKind };

/**
 * Upload allow-list. The stored MIME type and kind come from this table, never from
 * the client, so a renamed .html can't be served as a page.
 */
const TYPES: Record<string, TypeInfo> = {
  pdf: { mime: 'application/pdf', kind: 'PDF' },

  jpg: { mime: 'image/jpeg', kind: 'IMAGE' },
  jpeg: { mime: 'image/jpeg', kind: 'IMAGE' },
  png: { mime: 'image/png', kind: 'IMAGE' },
  gif: { mime: 'image/gif', kind: 'IMAGE' },
  webp: { mime: 'image/webp', kind: 'IMAGE' },
  avif: { mime: 'image/avif', kind: 'IMAGE' },

  doc: { mime: 'application/msword', kind: 'DOCUMENT' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'DOCUMENT' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'DOCUMENT' },
  rtf: { mime: 'application/rtf', kind: 'DOCUMENT' },
  txt: { mime: 'text/plain; charset=utf-8', kind: 'DOCUMENT' },

  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'PRESENTATION' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'PRESENTATION' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'PRESENTATION' },

  xls: { mime: 'application/vnd.ms-excel', kind: 'SPREADSHEET' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'SPREADSHEET' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'SPREADSHEET' },
  csv: { mime: 'text/csv; charset=utf-8', kind: 'SPREADSHEET' },

  epub: { mime: 'application/epub+zip', kind: 'EBOOK' },

  mp4: { mime: 'video/mp4', kind: 'VIDEO' },
  webm: { mime: 'video/webm', kind: 'VIDEO' },
  mov: { mime: 'video/quicktime', kind: 'VIDEO' },

  mp3: { mime: 'audio/mpeg', kind: 'AUDIO' },
  m4a: { mime: 'audio/mp4', kind: 'AUDIO' },
  wav: { mime: 'audio/wav', kind: 'AUDIO' },
  ogg: { mime: 'audio/ogg', kind: 'AUDIO' },

  zip: { mime: 'application/zip', kind: 'ARCHIVE' },
  rar: { mime: 'application/vnd.rar', kind: 'ARCHIVE' },
  '7z': { mime: 'application/x-7z-compressed', kind: 'ARCHIVE' },
};

export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

/** Types the browser may render in place (preview); everything else is forced to download. */
const INLINE_KINDS = new Set<FileKind>(['IMAGE', 'PDF', 'VIDEO', 'AUDIO']);

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function detectType(filename: string): (TypeInfo & { extension: string }) | null {
  const extension = extensionOf(filename);
  const info = TYPES[extension];
  return info ? { ...info, extension } : null;
}

export function canRenderInline(kind: FileKind, mime: string) {
  return INLINE_KINDS.has(kind) || mime.startsWith('text/plain');
}

/** Display name without path parts, control characters or surrounding spaces. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'file';
}
