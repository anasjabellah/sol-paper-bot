export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (API_TOKEN && method !== 'GET') headers.authorization = `Bearer ${API_TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', `Cannot reach the API at ${API_URL}. Is it running?`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'API returned a non-JSON response');
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, j.error ?? 'ERROR', j.message ?? `HTTP ${res.status}`, j.details, json);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
};
