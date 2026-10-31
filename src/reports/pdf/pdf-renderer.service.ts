import { existsSync } from 'node:fs';
import { Injectable, Logger, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'puppeteer-core';
import { msg } from '../../i18n/i18n.js';

/** Where Chrome, Chromium or Edge usually live, tried in order when PDF_CHROME_PATH isn't set. */
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** Renders at most this many PDFs at once; the rest wait their turn. */
const MAX_PARALLEL = 2;
const RENDER_TIMEOUT_MS = 30_000;

export type PdfOptions = { landscape?: boolean; footer: string };

/**
 * HTML → PDF through headless Chrome: the only engine that shapes Arabic and lays out the
 * report's CSS faithfully. One browser is started on the first report and reused; each report
 * gets its own page with scripts off and every network request blocked (fonts and images are
 * inlined), so a report can only show what the template put in it.
 */
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRenderer.name);
  private browser: Promise<Browser> | null = null;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly config: ConfigService) {}

  async render(html: string, opts: PdfOptions): Promise<Buffer> {
    await this.slot();
    try {
      const browser = await this.launch();
      const page = await browser.newPage();
      try {
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (req) => (req.url().startsWith('data:') ? req.continue() : req.abort()));
        await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
        await page.evaluate('document.fonts.ready');
        const pdf = await page.pdf({
          format: 'A4',
          landscape: opts.landscape ?? false,
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: opts.footer,
          margin: { top: '12mm', bottom: '16mm', left: '11mm', right: '11mm' },
          timeout: RENDER_TIMEOUT_MS,
        });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`PDF rendering failed: ${String(err)}`);
      throw new ServiceUnavailableException(msg('reports.pdfUnavailable'));
    } finally {
      this.release();
    }
  }

  async onModuleDestroy() {
    const browser = await this.browser?.catch(() => null);
    await browser?.close().catch(() => undefined);
  }

  private launch() {
    if (!this.browser) {
      const executablePath = this.config.get<string>('PDF_CHROME_PATH') || CANDIDATES.find((p) => existsSync(p));
      if (!executablePath) {
        this.logger.error('No Chrome/Chromium found for PDF reports: set PDF_CHROME_PATH');
        throw new ServiceUnavailableException(msg('reports.pdfUnavailable'));
      }
      this.browser = import('puppeteer-core')
        .then(({ default: puppeteer }) =>
          puppeteer.launch({
            executablePath,
            headless: true,
            args: ['--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
          }),
        )
        .then((b) => {
          // A crashed browser is started again on the next report.
          b.on('disconnected', () => (this.browser = null));
          return b;
        })
        .catch((err) => {
          this.browser = null;
          throw err;
        });
    }
    return this.browser;
  }

  private slot() {
    if (this.running < MAX_PARALLEL) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
