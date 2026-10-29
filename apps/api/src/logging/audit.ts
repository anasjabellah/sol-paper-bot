import type { FastifyBaseLogger } from 'fastify';
import type { AuditLevel } from '@spb/shared';
import type { Repository } from '../database/repository';
import type { Db } from '../database/db';
import type { Clock } from '../lib/util';

/**
 * Structured audit trail: every entry goes to the persistent audit_log table
 * AND the structured (pino) application log.
 */
export class AuditLogger {
  constructor(
    private readonly repo: Repository,
    private readonly log: FastifyBaseLogger,
    private readonly clock: Clock,
  ) {}

  async record(level: AuditLevel, type: string, message: string, data?: unknown, tx?: Db): Promise<void> {
    this.log[level]({ audit: true, type, data }, message);
    try {
      await this.repo.insertAudit(level, type, message, data, this.clock(), tx);
    } catch (err) {
      // Audit persistence must never crash the caller; surface it in the app log instead.
      this.log.error({ err, type }, 'failed to persist audit entry');
      if (tx) throw err;
    }
  }

  info(type: string, message: string, data?: unknown, tx?: Db) {
    return this.record('info', type, message, data, tx);
  }
  warn(type: string, message: string, data?: unknown, tx?: Db) {
    return this.record('warn', type, message, data, tx);
  }
  error(type: string, message: string, data?: unknown, tx?: Db) {
    return this.record('error', type, message, data, tx);
  }
}
