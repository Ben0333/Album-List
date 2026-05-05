type Json = unknown;

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: Json): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    const apiError = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : null;
    const message =
      (typeof apiError === 'string'
        ? apiError
        : apiError && typeof apiError === 'object' && 'message' in apiError && typeof apiError.message === 'string'
          ? apiError.message
          : null) ?? res.statusText ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: Json) => request<T>('POST', path, body),
  put: <T>(path: string, body?: Json) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: Json) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: Json) => request<T>('DELETE', path, body)
};

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
