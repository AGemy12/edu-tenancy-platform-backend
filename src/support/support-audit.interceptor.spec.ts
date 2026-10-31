import { NotFoundException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { SupportAuditInterceptor } from './support-audit.interceptor.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function setup({ skip = false } = {}) {
  const create = vi.fn().mockResolvedValue({});
  const interceptor = new SupportAuditInterceptor({ supportAction: { create } } as unknown as PrismaService, { getAllAndOverride: () => skip } as unknown as Reflector);
  const ctx = (method: string, supportSessionId?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: '/api/teachers?x=1', user: { supportSessionId } }), getResponse: () => ({ statusCode: 201 }) }),
      getHandler: () => null,
      getClass: () => null,
    }) as unknown as ExecutionContext;
  return { create, interceptor, ctx };
}
const ok: CallHandler = { handle: () => of('done') };

describe('SupportAuditInterceptor', () => {
  it('logs writes made in support mode, without the query string', async () => {
    const { create, interceptor, ctx } = setup();
    await firstValueFrom(interceptor.intercept(ctx('POST', 's1'), ok));
    expect(create).toHaveBeenCalledWith({ data: { sessionId: 's1', method: 'POST', path: '/api/teachers', status: 201 } });
  });

  it('logs a refused write with its status and still throws', async () => {
    const { create, interceptor, ctx } = setup();
    const failing: CallHandler = { handle: () => throwError(() => new NotFoundException()) };
    await expect(firstValueFrom(interceptor.intercept(ctx('DELETE', 's1'), failing))).rejects.toBeInstanceOf(NotFoundException);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ method: 'DELETE', status: 404 }) });
  });

  it('ignores reads, normal sessions and routes marked to skip', async () => {
    for (const [s, method, skip] of [[setup(), 'GET', false], [setup(), 'POST', false], [setup({ skip: true }), 'POST', true]] as const) {
      await firstValueFrom(s.interceptor.intercept(s.ctx(method, method === 'GET' || skip ? 's1' : undefined), ok));
      expect(s.create).not.toHaveBeenCalled();
    }
  });
});
