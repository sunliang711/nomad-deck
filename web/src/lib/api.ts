export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiRequestOptions {
  skipAuthPrompt?: boolean;
}

type UnauthorizedHandler = () => Promise<boolean>;

let csrfToken = '';
let unauthorizedHandler: UnauthorizedHandler | null = null;
let reauthPromise: Promise<boolean> | null = null;

export function setCSRFToken(token: string) {
  csrfToken = token || '';
}

export function getCSRFToken(): string {
  return csrfToken;
}

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  unauthorizedHandler = fn;
}

export function isReauthenticating(): boolean {
  return reauthPromise !== null;
}

async function waitForReauth(): Promise<boolean> {
  if (!unauthorizedHandler) return false;
  if (!reauthPromise) {
    reauthPromise = unauthorizedHandler().finally(() => {
      reauthPromise = null;
    });
  }
  return reauthPromise;
}

async function parseError(resp: Response): Promise<ApiError> {
  const text = await resp.text();
  try {
    const j = JSON.parse(text);
    const code = j?.error?.code || 'error';
    const msg = j?.error?.message || j?.run?.error_message || text || `HTTP ${resp.status}`;
    return new ApiError(resp.status, code, msg);
  } catch {
    return new ApiError(resp.status, 'http_error', text || `HTTP ${resp.status}`);
  }
}

function shouldPromptReauth(path: string, options?: ApiRequestOptions): boolean {
  if (options?.skipAuthPrompt || !unauthorizedHandler) return false;
  return (
    path !== '/api/v1/auth/login' &&
    path !== '/api/v1/auth/status' &&
    path !== '/api/v1/auth/setup' &&
    path !== '/api/v1/auth/logout'
  );
}

async function fetchWithAuth(
  path: string,
  buildInit: () => RequestInit,
  options?: ApiRequestOptions,
): Promise<Response> {
  let resp = await fetch(path, buildInit());
  if (resp.status === 401 && shouldPromptReauth(path, options)) {
    const ok = await waitForReauth();
    if (ok) {
      resp = await fetch(path, buildInit());
    }
  }
  return resp;
}

export async function api<T = any>(
  path: string,
  init: RequestInit = {},
  options?: ApiRequestOptions,
): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const buildInit = (): RequestInit => {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
    return {
      ...init,
      method,
      headers,
      credentials: 'same-origin',
    };
  };

  const resp = await fetchWithAuth(path, buildInit, options);
  if (!resp.ok) {
    throw await parseError(resp);
  }
  if (resp.status === 204) {
    return undefined as T;
  }
  const ct = resp.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return (await resp.json()) as T;
  }
  return (await resp.text()) as T;
}

export const apiGet = <T = any>(path: string, options?: ApiRequestOptions) => api<T>(path, {}, options);

export const apiPost = <T = any>(path: string, body?: unknown, options?: ApiRequestOptions) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, options);

export const apiPut = <T = any>(path: string, body?: unknown, options?: ApiRequestOptions) =>
  api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }, options);

export const apiDelete = <T = any>(path: string, body?: unknown, options?: ApiRequestOptions) =>
  api<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }, options);

// apiUpload builds FormData with ordered text fields BEFORE the file part.
export async function apiUpload<T = any>(
  path: string,
  orderedFields: Array<[string, string]>,
  file: File,
  fileField = 'file',
): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of orderedFields) {
    fd.append(k, v);
  }
  fd.append(fileField, file);
  return api<T>(path, { method: 'POST', body: fd });
}

export async function apiDownload(path: string, body?: unknown, fallbackFilename = 'download.bin') {
  const method = body === undefined ? 'GET' : 'POST';
  const buildInit = (): RequestInit => {
    const headers = new Headers();
    if (method === 'POST') {
      headers.set('Content-Type', 'application/json');
      if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
    }
    return {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    };
  };

  const resp = await fetchWithAuth(path, buildInit);
  if (!resp.ok) {
    throw await parseError(resp);
  }
  const blob = await resp.blob();
  const disp = resp.headers.get('Content-Disposition') || '';
  const m = disp.match(/filename="?([^"]+)"?/);
  const name = m?.[1] || fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function openSSE(
  path: string,
  handlers: {
    onEvent?: (event: string, data: any) => void;
    onError?: (err: any) => void;
    onOpen?: () => void;
  },
): () => void {
  const es = new EventSource(path, { withCredentials: true });
  es.onopen = () => handlers.onOpen?.();
  es.onerror = (ev) => handlers.onError?.(ev);
  const bind = (name: string) => {
    es.addEventListener(name, (ev: MessageEvent) => {
      try {
        handlers.onEvent?.(name, JSON.parse(ev.data));
      } catch {
        handlers.onEvent?.(name, ev.data);
      }
    });
  };
  for (const ev of ['step', 'log', 'progress', 'done', 'watch', 'update', 'change', 'end', 'snapshot']) {
    bind(ev);
  }
  es.onmessage = (ev) => {
    try {
      handlers.onEvent?.('message', JSON.parse(ev.data));
    } catch {
      handlers.onEvent?.('message', ev.data);
    }
  };
  return () => es.close();
}

export function wsURL(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

// fmtTime renders absent Go timestamps as an empty value in management views.
export function fmtTime(v?: string | null): string {
  if (!v || v.startsWith('0001-01-01T00:00:00')) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
