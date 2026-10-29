import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PaginationSchema } from '@spb/shared';
import { parseOrThrow } from '../lib/errors';

export function registerLogRoutes(api: FastifyInstance) {
  api.get('/logs/decisions', async (req) => {
    const q = parseOrThrow(PaginationSchema.extend({ action: z.enum(['BUY', 'SELL', 'SKIP']).optional() }), req.query, 'query');
    return { items: await api.services.repo.listDecisions(q) };
  });

  api.get('/logs/audit', async (req) => {
    const q = parseOrThrow(PaginationSchema.extend({ level: z.enum(['info', 'warn', 'error']).optional() }), req.query, 'query');
    return { items: await api.services.repo.listAudit(q) };
  });
}
