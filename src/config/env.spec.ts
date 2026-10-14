import { describe, expect, it } from 'vitest';
import { envProblems } from './env.js';

const long = (c: string) => c.repeat(40);
const dev = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b' };
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://x',
  JWT_ACCESS_SECRET: long('a'),
  JWT_REFRESH_SECRET: long('b'),
  FILES_URL_SECRET: long('c'),
  INTEGRATIONS_SECRET: long('d'),
  APP_URL: 'https://app.example.com',
  CORS_ORIGIN: 'https://app.example.com',
};

describe('envProblems', () => {
  it('only needs the database and JWT secrets in development', () => {
    expect(envProblems(dev)).toEqual([]);
    expect(envProblems({ ...dev, JWT_REFRESH_SECRET: '' })).toEqual(['JWT_REFRESH_SECRET is required']);
  });

  it('accepts a complete production setup', () => {
    expect(envProblems(prod)).toEqual([]);
  });

  it('rejects missing URLs, placeholders, short and shared secrets in production', () => {
    expect(envProblems({ ...prod, APP_URL: undefined })).toEqual(['APP_URL is required']);
    expect(envProblems({ ...prod, FILES_URL_SECRET: 'change-me-files-secret' })).toEqual([
      'FILES_URL_SECRET still has the example value',
    ]);
    expect(envProblems({ ...prod, INTEGRATIONS_SECRET: 'short' })).toEqual([
      'INTEGRATIONS_SECRET must be at least 32 characters',
    ]);
    expect(envProblems({ ...prod, JWT_REFRESH_SECRET: prod.JWT_ACCESS_SECRET })).toEqual([
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
    ]);
  });
});
