import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { RealtimeAdapter } from './realtime/realtime.adapter.js';

const API_VERSION = '1.0.0';

async function bootstrap() {
  // rawBody: Zoom webhooks are verified against the exact bytes they were signed over.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const port = Number(process.env.PORT ?? 4000);
  const production = process.env.NODE_ENV === 'production';

  // Behind a reverse proxy (nginx, a load balancer), the rate limiter must see the client's IP, not the proxy's.
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  // Security headers. The API serves JSON plus signed library files that the web app shows in
  // <img>/<video>/<iframe> on another origin, so those two policies are relaxed.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      frameguard: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.setGlobalPrefix('api');
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  // Content-Disposition is exposed so the web app can save report PDFs under their real names.
  app.enableCors({ origin: origins, credentials: true, exposedHeaders: ['Content-Disposition'] });
  // Real-time channel (notifications, messages) on the same server, same origins.
  app.useWebSocketAdapter(new RealtimeAdapter(app, origins));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // API docs are for development; set SWAGGER_ENABLED=true to publish them in production.
  const docs = !production || process.env.SWAGGER_ENABLED === 'true';
  if (docs) {
    const swagger = new DocumentBuilder()
      .setTitle('Edu Tenancy Platform API')
      .setDescription('Multi-tenant platform for teachers and educational centers')
      .setVersion(API_VERSION)
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));
  }

  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`API v${API_VERSION} ready at http://localhost:${port}/api${docs ? '  (docs: /api/docs)' : ''}`, 'Bootstrap');
}

await bootstrap();
