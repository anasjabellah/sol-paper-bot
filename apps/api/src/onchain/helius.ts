/**
 * Read-only Helius JSON-RPC client. Only an explicit allowlist of read methods can be called;
 * every call (including each retry) is reserved against the budget first. Calls are serialized and
 * spaced by minIntervalMs (rate limit); HTTP 429 is retried at most maxRetries times with backoff,
 * honouring Retry-After. The API key lives only in the URL passed in and is redacted from every
 * error message.
 */
import type { UsageBudget } from './budget';

export const ALLOWED_RPC_METHODS = new Set(['getSignaturesForAddress', 'getTransaction', 'getAccountInfo']);

export class BudgetExhaustedError extends Error {}
export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}
export class RateLimitedError extends RpcError {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message, 429);
  }
}

/** Replaces any api-key query value (and the raw key, if given) with '***'. */
export function redact(text: string, apiKey?: string): string {
  let out = text.replace(/(api[-_]?key=)[^&\s"']+/gi, '$1***');
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('***');
  return out;
}

export function withApiKey(baseUrl: string, apiKey: string): string {
  const u = new URL(baseUrl);
  u.searchParams.set('api-key', apiKey);
  return u.toString();
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
}

export class HeliusRpc {
  private id = 0;

  constructor(
    private readonly opts: {
      url: string;
      apiKey: string;
      budget: UsageBudget;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      /** Minimum spacing between request starts (default 150 ms, i.e. at most ~6.7 req/s). */
      minIntervalMs?: number;
      maxRetries?: number;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;

  /** Serialized, paced and 429-retried call. */
  call<T>(method: string, params: unknown[]): Promise<T> {
    if (!ALLOWED_RPC_METHODS.has(method)) return Promise.reject(new RpcError(`RPC method ${method} is not on the read-only allowlist`));
    const run = this.queue.then(() => this.callWithRetry<T>(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callWithRetry<T>(method: string, params: unknown[]): Promise<T> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    const clock = this.opts.clock ?? Date.now;
    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastStart + (this.opts.minIntervalMs ?? 150) - clock();
      if (wait > 0) await sleep(wait);
      this.lastStart = clock();
      try {
        return await this.once<T>(method, params);
      } catch (err) {
        if (!(err instanceof RateLimitedError) || attempt >= maxRetries) throw err;
        await sleep(err.retryAfterMs ?? 1_000 * 2 ** attempt);
      }
    }
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.opts.budget.tryRpcCall()) throw new BudgetExhaustedError(`Budget reached; ${method} not sent`);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let text: string;
    try {
      const res = await fetchImpl(this.opts.url, {
        method: 'POST', // JSON-RPC transport; only allowlisted read methods are ever sent
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      text = await res.text();
      this.opts.budget.recordRpcBytes(Buffer.byteLength(text));
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        throw new RateLimitedError(`${method}: HTTP 429 rate limited`, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : undefined);
      }
      if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status} ${redact(text.slice(0, 200), this.opts.apiKey)}`, res.status);
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(`${method}: ${redact(String((err as Error).message ?? err), this.opts.apiKey)}`);
    }
    let body: { result?: T; error?: { code: number; message: string } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(`${method}: non-JSON response`);
    }
    if (body.error?.code === 429) throw new RateLimitedError(`${method}: JSON-RPC 429 rate limited`);
    if (body.error) throw new RpcError(`${method}: ${body.error.code} ${redact(body.error.message, this.opts.apiKey)}`, body.error.code);
    return body.result as T;
  }

  getSignaturesForAddress(address: string, opts: { until?: string; before?: string; limit: number }): Promise<SignatureInfo[]> {
    return this.call('getSignaturesForAddress', [address, { ...opts, commitment: 'confirmed' }]);
  }

  /** Read-only account fetch (used to verify PumpSwap Pool accounts). */
  async getAccountInfo(address: string): Promise<{ owner: string; data: [string, string] } | null> {
    const res = await this.call<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    return res?.value ?? null;
  }

  getTransaction<T>(signature: string, maxSupportedTransactionVersion: number): Promise<T | null> {
    return this.call('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion }]);
  }
}
