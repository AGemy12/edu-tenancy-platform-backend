import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import {
  ChangePasswordDto,
  CreateTenantDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterTenantDto,
  ResetPasswordDto,
  SwitchMembershipDto,
  UpdateProfileDto,
} from './dto/auth.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';
import { AllowExpired } from '../tenants/subscription.guard.js';
import { AllowSuspended } from './account-status.js';

/** Per-IP limits on the routes that guess or send something: passwords, emails, sign-ups. */
const perMinute = (limit: number) => Throttle({ default: { limit, ttl: 60_000 } });

@ApiTags('auth')
@Controller('auth')
// Signing out and managing your own account keep working after the center's subscription lapses.
@AllowExpired()
@AllowSuspended()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @perMinute(5)
  @Post('register')
  register(@Body() dto: RegisterTenantDto) {
    return this.auth.registerTenant(dto);
  }

  @Public()
  @perMinute(10)
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @perMinute(60)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** Moves the session to another of the user's centers; returns a new token pair. */
  @Post('switch')
  @HttpCode(200)
  @ApiBearerAuth()
  switch(@CurrentUser() user: JwtUser, @Body() dto: SwitchMembershipDto) {
    return this.auth.switch(user, dto);
  }

  /** A signed-in user opens a center of their own; the session moves into it. */
  @perMinute(5)
  @Post('tenants')
  @ApiBearerAuth()
  createTenant(@CurrentUser() user: JwtUser, @Body() dto: CreateTenantDto) {
    return this.auth.createTenant(user, dto);
  }

  @Public()
  @perMinute(5)
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Lang() locale: Locale) {
    return this.auth.forgotPassword(dto.email, locale);
  }

  @Public()
  @perMinute(10)
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user);
  }

  @Patch('me')
  @ApiBearerAuth()
  updateProfile(@CurrentUser() user: JwtUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user, dto);
  }

  @perMinute(10)
  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth()
  changePassword(@CurrentUser() user: JwtUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }
}
