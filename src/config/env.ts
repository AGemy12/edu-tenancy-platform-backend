/**
 * Checks the environment once at startup, so a missing secret stops the API right away instead of
 * failing on the first request that needs it. Production is stricter: real URLs and long, distinct
 * secrets (the `.env.example` placeholders are rejected).
 */
const ALWAYS = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
const IN_PRODUCTION = ['APP_URL', 'CORS_ORIGIN', 'FILES_URL_SECRET', 'INTEGRATIONS_SECRET'] as const;
const SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FILES_URL_SECRET', 'INTEGRATIONS_SECRET'] as const;
const MIN_SECRET_LENGTH = 32;

export function envProblems(env: Record<string, unknown>): string[] {
  const value = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  const production = value('NODE_ENV') === 'production';
  const required = production ? [...ALWAYS, ...IN_PRODUCTION] : ALWAYS;

  const problems = required.filter((key) => !value(key)).map((key) => `${key} is required`);
  if (production) {
    for (const key of SECRETS) {
      const secret = value(key);
      if (!secret) continue;
      if (secret.startsWith('change-me')) problems.push(`${key} still has the example value`);
      else if (secret.length < MIN_SECRET_LENGTH) problems.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (value('JWT_ACCESS_SECRET') && value('JWT_ACCESS_SECRET') === value('JWT_REFRESH_SECRET')) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
  }
  return problems;
}

/** `ConfigModule` hook: throws with every problem listed. */
export function validateEnv(env: Record<string, unknown>) {
  const problems = envProblems(env);
  if (problems.length) throw new Error(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}
