import { registerDecorator, type ValidationOptions } from 'class-validator';
import type { MessageKey } from '../i18n/i18n.js';

/**
 * What a new password must contain. The frontend mirrors these rules in `lib/password-policy.ts`
 * to show a live checklist; keep the two in step.
 */
export const PASSWORD_MIN = 8;
/** bcrypt ignores everything after 72 bytes. */
export const PASSWORD_MAX = 72;

export const PASSWORD_RULES = {
  length: (v: string) => v.length >= PASSWORD_MIN && v.length <= PASSWORD_MAX,
  upper: (v: string) => /\p{Lu}/u.test(v),
  lower: (v: string) => /\p{Ll}/u.test(v),
  digit: (v: string) => /\p{Nd}/u.test(v),
  symbol: (v: string) => /[^\p{L}\p{N}\s]/u.test(v),
} as const;

export type PasswordRule = keyof typeof PASSWORD_RULES;

/** The rules a password breaks; empty when it is acceptable. */
export function passwordProblems(value: string): PasswordRule[] {
  return (Object.keys(PASSWORD_RULES) as PasswordRule[]).filter((rule) => !PASSWORD_RULES[rule](value));
}

const PASSWORD_WEAK: MessageKey = 'validation.passwordWeak';

/** A password that follows `PASSWORD_RULES`. Combine with `@IsOptional()` for optional ones. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isStrongPassword',
      target: target.constructor,
      propertyName,
      options: { message: PASSWORD_WEAK, ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && passwordProblems(value).length === 0,
      },
    });
}
