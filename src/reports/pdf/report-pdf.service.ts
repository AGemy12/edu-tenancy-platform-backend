import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../library/storage.service.js';
import type { Locale } from '../../i18n/locale.js';
import type {
  CenterReport,
  CourseReport,
  RegisterReport,
  StudentReport,
  StudentsReport,
  TeacherReport,
} from '../reports.service.js';
import type { Brand } from './components.js';
import { formatter } from './format.js';
import { PdfRenderer } from './pdf-renderer.service.js';
import { centerPdf, coursePdf, registerPdf, studentPdf, studentsPdf, teacherPdf, type Rendered } from './templates.js';

type Report = StudentReport | StudentsReport | RegisterReport | TeacherReport | CourseReport | CenterReport;

export type PdfFile = { data: Buffer; fileName: string };

/** Turns a computed report into a branded PDF in the reader's language. */
@Injectable()
export class ReportPdfService {
  private readonly logger = new Logger(ReportPdfService.name);

  constructor(
    private readonly renderer: PdfRenderer,
    private readonly storage: StorageService,
  ) {}

  async render(report: Report, locale: Locale, logoKey: string | null): Promise<PdfFile> {
    const f = formatter(locale, report.period.timezone);
    const brand: Brand = { center: report.center.name, timezone: report.period.timezone, logo: await this.logo(logoKey) };
    const doc = this.template(report, f, brand);
    const data = await this.renderer.render(doc.html, { landscape: doc.landscape, footer: doc.footer });
    return { data, fileName: doc.fileName };
  }

  private template(report: Report, f: ReturnType<typeof formatter>, brand: Brand): Rendered {
    switch (report.kind) {
      case 'student':
        return studentPdf(f, brand, report);
      case 'students':
        return studentsPdf(f, brand, report);
      case 'register':
        return registerPdf(f, brand, report);
      case 'teacher':
        return teacherPdf(f, brand, report);
      case 'course':
        return coursePdf(f, brand, report);
      case 'center':
        return centerPdf(f, brand, report);
    }
  }

  /** The center's logo as a data URI (the renderer loads nothing from the network). */
  private async logo(key: string | null) {
    if (!key) return null;
    try {
      return `data:image/png;base64,${(await readFile(this.storage.resolve(key))).toString('base64')}`;
    } catch (err) {
      this.logger.warn(`Logo ${key} unreadable: ${String(err)}`);
      return null;
    }
  }
}
