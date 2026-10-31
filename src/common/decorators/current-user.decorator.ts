import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccountStatus, Role } from '../../generated/prisma/client.js';

export type JwtUser = {
  id: string;
  email: string;
  role: Role;
  status: AccountStatus;
  tenantId: string | null;
  teacherId: string | null;
  studentId: string | null;
  /** The center this session is signed into; null for the platform operator's console. */
  membershipId: string | null;
  /** Set when a platform admin is working as this member (support mode): the session and the admin. */
  supportSessionId?: string | null;
  supportActorId?: string | null;
};

export const CurrentUser = createParamDecorator(
  (data: keyof JwtUser | undefined, ctx: ExecutionContext): JwtUser | JwtUser[keyof JwtUser] => {
    const req = ctx.switchToHttp().getRequest<{ user: JwtUser }>();
    return data ? req.user[data] : req.user;
  },
);
