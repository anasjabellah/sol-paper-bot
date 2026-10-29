import type { ZodError, ZodType, ZodTypeDef } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function formatZodIssues(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validate untrusted input; throws a 400 HttpError with field-level issues. */
export function parseOrThrow<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, what = 'request'): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${what}`, formatZodIssues(r.error));
  return r.data;
}
