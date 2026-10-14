import { BadRequestException, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryController } from './library.controller.js';
import { LibraryAdminController } from './library-admin.controller.js';
import { LibraryAdminService } from './library-admin.service.js';
import { QuotaService } from './quota.service.js';
import { PlansModule } from '../plans/plans.module.js';
import { LibraryService } from './library.service.js';
import { StorageService } from './storage.service.js';
import { detectType } from './file-types.js';
import { msg } from '../i18n/i18n.js';

@Module({
  imports: [
    PlansModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Stream to a temp file instead of buffering big videos/books in memory.
        dest: path.join(tmpdir(), 'edu-uploads'),
        // Absolute ceiling; each package sets its own (lower) per-file limit in QuotaService.
        limits: { fileSize: Number(config.get('LIBRARY_MAX_FILE_MB') ?? 1024) * 1024 * 1024, files: 1 },
        // Busboy defaults to latin1, which garbles Arabic file names.
        defParamCharset: 'utf8',
        fileFilter: (_req, file, cb) => {
          if (detectType(file.originalname)) cb(null, true);
          else cb(new BadRequestException(msg('library.unsupportedTypeNamed', { name: file.originalname })), false);
        },
      }),
    }),
  ],
  controllers: [LibraryController, LibraryAdminController],
  providers: [LibraryService, LibraryAdminService, QuotaService, StorageService],
})
export class LibraryModule {}
