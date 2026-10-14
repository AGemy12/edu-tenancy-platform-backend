import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ChangePasswordDto } from './dto/auth.dto.js';
import { CreateStudentDto } from '../students/dto/student.dto.js';
import { passwordProblems } from './password-policy.js';

describe('passwordProblems', () => {
  it('accepts a password that follows every rule', () => {
    expect(passwordProblems('Password123!')).toEqual([]);
    expect(passwordProblems('Ab1@abcd')).toEqual([]);
  });

  it('names each rule that is broken', () => {
    expect(passwordProblems('short')).toEqual(['length', 'upper', 'digit', 'symbol']);
    expect(passwordProblems('password123!')).toEqual(['upper']);
    expect(passwordProblems('PASSWORD123!')).toEqual(['lower']);
    expect(passwordProblems('Password!!!!')).toEqual(['digit']);
    expect(passwordProblems('Password1234')).toEqual(['symbol']);
  });

  it('does not count spaces as symbols', () => {
    expect(passwordProblems('Password 123')).toEqual(['symbol']);
  });

  it('rejects passwords bcrypt would truncate', () => {
    expect(passwordProblems(`Aa1@${'x'.repeat(69)}`)).toEqual(['length']);
  });
});

describe('@IsStrongPassword', () => {
  const errors = (cls: new () => object, body: object) =>
    validateSync(plainToInstance(cls, body)).flatMap((e) => Object.values(e.constraints ?? {}));

  it('reports the i18n key for a weak password', () => {
    expect(errors(ChangePasswordDto, { currentPassword: 'x', newPassword: 'password' })).toEqual([
      'validation.passwordWeak',
    ]);
    expect(errors(ChangePasswordDto, { currentPassword: 'x', newPassword: 'Password123!' })).toEqual([]);
  });

  it('still lets accounts be created without a password', () => {
    expect(errors(CreateStudentDto, { fullName: 'Sara', email: 'sara@x.test' })).toEqual([]);
    expect(errors(CreateStudentDto, { fullName: 'Sara', email: 'sara@x.test', password: 'weak' })).toEqual([
      'validation.passwordWeak',
    ]);
  });
});
