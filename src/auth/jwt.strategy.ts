import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';

/** `mid` is the membership the session is signed into; null only for the platform operator's console. */
export type AccessPayload = { sub: string; mid: string | null };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessPayload): Promise<JwtUser> {
    const membershipId = payload.mid ?? null;
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        isPlatformAdmin: true,
        memberships: {
          where: { id: membershipId ?? '' },
          select: {
            id: true,
            role: true,
            status: true,
            tenantId: true,
            tenant: { select: { status: true } },
            teacher: { select: { id: true } },
            student: { select: { id: true } },
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException();

    if (membershipId) {
      const m = user.memberships[0];
      if (!m) throw new UnauthorizedException(msg('auth.invalidSession'));
      if (m.status === 'BLOCKED') throw new UnauthorizedException(msg('auth.blocked'));
      if (m.tenant.status !== 'ACTIVE') throw new UnauthorizedException(msg('auth.tenantSuspended'));
      return {
        id: user.id,
        email: user.email,
        role: m.role,
        status: m.status,
        tenantId: m.tenantId,
        teacherId: m.teacher?.id ?? null,
        studentId: m.student?.id ?? null,
        membershipId: m.id,
      };
    }

    if (!user.isPlatformAdmin) throw new UnauthorizedException(msg('auth.invalidSession'));
    return { id: user.id, email: user.email, role: 'SUPER_ADMIN', status: 'ACTIVE', tenantId: null, teacherId: null, studentId: null, membershipId: null };
  }
}
