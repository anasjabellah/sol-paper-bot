/**
 * Test-wide network guard (vitest setupFiles): tests may only reach loopback hosts.
 *
 *   - global fetch rejects any non-loopback URL
 *   - global WebSocket throws for any non-loopback URL
 *   - ONCHAIN_FORBID_NETWORK=true, so the on-chain CLI (and any child process inheriting the
 *     environment, which also inherits VITEST) refuses remote endpoints even with --live
 *
 * Production code injects fetch / WebSocket factories; tests pass fakes or a local server.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!isLoopback(url)) return Promise.reject(new Error(`[test network guard] blocked non-loopback fetch to ${hostOf(url)}`));
  return realFetch(input, init);
}) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;
if (RealWebSocket) {
  class GuardedWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (!isLoopback(String(url))) throw new Error(`[test network guard] blocked non-loopback WebSocket to ${hostOf(String(url))}`);
      super(url, protocols);
    }
  }
  globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;
}

process.env.ONCHAIN_FORBID_NETWORK = 'true';
