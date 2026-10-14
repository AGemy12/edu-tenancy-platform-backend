import { BadRequestException, NotFoundException, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { localizeErrorBody } from './i18n-exception.filter.js';
import { isMessageKey, msg, translate } from './i18n.js';
import { parseLocale } from './locale.js';
import { messages } from './messages.js';

describe('parseLocale', () => {
  it('defaults to Arabic', () => {
    expect(parseLocale()).toBe('ar');
    expect(parseLocale('')).toBe('ar');
    expect(parseLocale('fr-FR,de;q=0.8')).toBe('ar');
    expect(parseLocale('*')).toBe('ar');
    expect(parseLocale(';;;,,q=abc')).toBe('ar');
  });

  it('reads region tags and case-insensitive values', () => {
    expect(parseLocale('en-US')).toBe('en');
    expect(parseLocale('EN-gb')).toBe('en');
    expect(parseLocale('ar-EG')).toBe('ar');
  });

  it('honours q-values', () => {
    expect(parseLocale('en-US,en;q=0.9,ar;q=0.8')).toBe('en');
    expect(parseLocale('en;q=0.5,ar;q=0.8')).toBe('ar');
    expect(parseLocale('fr,en;q=0.7,ar;q=0.3')).toBe('en');
    expect(parseLocale('en;q=0,fr')).toBe('ar');
    expect(parseLocale('ar;q=0.5, en;q=0.5')).toBe('ar'); // ties keep header order
  });

  it('accepts header arrays', () => {
    expect(parseLocale(['fr', 'en;q=0.4'])).toBe('en');
  });
});

describe('translate', () => {
  it('fills params', () => {
    expect(translate('en', 'students.quotaReached', { max: 50 })).toBe("You've reached your plan's student limit (50)");
    expect(translate('ar', 'students.quotaReached', { max: 50 })).toBe('وصلت للحد الأقصى من الطلاب لخطتك الحالية (50)');
  });

  it('leaves unknown placeholders and returns plain messages', () => {
    expect(translate('en', 'exams.markExceedsTotal')).toBe('The mark cannot exceed {total}');
    expect(translate('en', 'students.notFound')).toBe('Student not found');
  });

  it('has no empty translations', () => {
    for (const dict of Object.values(messages)) {
      for (const value of Object.values(dict)) expect(value.trim()).not.toBe('');
    }
  });

  it('recognises keys only', () => {
    expect(isMessageKey('students.notFound')).toBe(true);
    expect(isMessageKey('Student not found')).toBe(false);
    expect(isMessageKey('toString')).toBe(false);
    expect(isMessageKey(42)).toBe(false);
  });
});

describe('localizeErrorBody', () => {
  const body = (err: { getResponse(): unknown; getStatus(): number }, locale: 'ar' | 'en') =>
    localizeErrorBody(err.getResponse(), err.getStatus(), locale);

  it('translates a LocalizedMessage into the Nest error shape', () => {
    const err = new NotFoundException(msg('students.notFound'));
    expect(body(err, 'en')).toEqual({ statusCode: 404, message: 'Student not found', error: 'Not Found' });
    expect(body(err, 'ar')).toEqual({ statusCode: 404, message: 'الطالب غير موجود', error: 'Not Found' });
    // The key doubles as the exception message for logs.
    expect(err.message).toBe('students.notFound');
  });

  it('interpolates params', () => {
    const err = new BadRequestException(msg('library.unsupportedTypeNamed', { name: 'a.exe' }));
    expect(body(err, 'en')).toEqual({ statusCode: 400, message: 'Unsupported file type: a.exe', error: 'Bad Request' });
  });

  it('translates a plain string key', () => {
    expect(localizeErrorBody('courses.notFound', 404, 'en')).toEqual({
      statusCode: 404,
      message: 'Course not found',
      error: 'Not Found',
    });
    expect(body(new NotFoundException('courses.notFound'), 'en')).toEqual({
      statusCode: 404,
      message: 'Course not found',
      error: 'Not Found',
    });
  });

  it('translates keys inside validation arrays and keeps other strings', () => {
    const err = new BadRequestException(['validation.passwordMinLength', 'email must be an email']);
    expect(body(err, 'en')).toEqual({
      statusCode: 400,
      message: ['Password must be at least 8 characters', 'email must be an email'],
      error: 'Bad Request',
    });
    expect(body(err, 'ar')).toMatchObject({ message: ['كلمة المرور يجب ألا تقل عن 8 أحرف', 'email must be an email'] });
  });

  it('leaves unknown strings untouched', () => {
    const err = new BadRequestException('Validation failed (uuid is expected)');
    expect(body(err, 'en')).toEqual({
      statusCode: 400,
      message: 'Validation failed (uuid is expected)',
      error: 'Bad Request',
    });
    expect(localizeErrorBody({ custom: true }, 409, 'en')).toEqual({ custom: true });
  });

  it('maps framework defaults (401, multer 413) to keys', () => {
    expect(body(new UnauthorizedException(), 'en')).toMatchObject({ statusCode: 401, message: 'Please sign in first' });
    expect(body(new PayloadTooLargeException('File too large'), 'en')).toEqual({
      statusCode: 413,
      message: 'The file is larger than the allowed size',
      error: 'Payload Too Large',
    });
  });
});
