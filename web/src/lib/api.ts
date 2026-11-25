export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrfToken = '';
let onUnauthorizedHandler: (() => void) | null = null;

export function setCSRFToken(token: string) {
  csrfToken = token || '';
}

export function getCSRFToken(): string {
  return csrfToken;
}

export function setOnUnauthorized(fn: (() => void) | null) {
  onUnauthorizedHandler = fn;
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

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const resp = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
  });
  if (!resp.ok) {
    if (resp.status === 401 && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/status') {
      onUnauthorizedHandler?.();
    }
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

export const apiGet = <T = any>(path: string) => api<T>(path);

export const apiPost = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const apiPut = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });

export const apiDelete = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) });

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
  const headers = new Headers();
  if (method === 'POST') {
    headers.set('Content-Type', 'application/json');
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  const resp = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      onUnauthorizedHandler?.();
    }
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
  for (const ev of ['step', 'log', 'done', 'watch', 'update', 'change', 'end', 'snapshot']) {
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

export function fmtTime(v?: string | null): string {
  if (!v) return '-';
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
