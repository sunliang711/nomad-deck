/** 升级阶段：前五个来自后台任务上报，confirm 是页面等待重启后的服务报告新版本，done 表示全部完成。 */
export type UpgradeStage = 'resolve' | 'download' | 'verify' | 'install' | 'restart' | 'confirm' | 'done';

export interface TaskProgress {
  stage: string;
  done?: number;
  total?: number;
}

export const UPGRADE_VERSION_PATTERN = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** 后台任务上报的阶段名转换为升级阶段；未知阶段返回 null。 */
export function upgradeStage(stage: string | undefined): UpgradeStage | null {
  return stage && ['resolve', 'download', 'verify', 'install', 'restart'].includes(stage)
    ? (stage as UpgradeStage)
    : null;
}

export function normalizedVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
}

export function formatDurationZh(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m} 分钟 ${rem} 秒` : `${m} 分钟`;
  }
  return `${s} 秒`;
}

export class VersionCheckTimeoutError extends Error {
  constructor() {
    super('version check timed out');
    this.name = 'VersionCheckTimeoutError';
  }
}

export interface WaitForVersionOptions {
  targetVersion: string;
  signal: AbortSignal;
  probe: (signal: AbortSignal) => Promise<string>;
  onReachable?: (version: string) => void;
  onUnavailable?: (cause: unknown) => void;
  interval?: number;
  timeout?: number;
  now?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function aborted(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const timer = globalThis.setTimeout(done, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    function done() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      globalThis.clearTimeout(timer);
      reject(aborted());
    }
  });
}

/** 等待重启后的服务报告目标版本；连接失败是正常的重启阶段，不立即判定失败。 */
export async function waitForVersion(options: WaitForVersionOptions): Promise<string> {
  const interval = options.interval ?? 1500;
  const now = options.now ?? Date.now;
  const wait = options.delay ?? defaultDelay;
  const deadline = now() + (options.timeout ?? 300_000);
  const want = normalizedVersion(options.targetVersion);

  while (true) {
    if (options.signal.aborted) throw aborted();
    if (now() >= deadline) throw new VersionCheckTimeoutError();
    try {
      const version = await options.probe(options.signal);
      if (want && normalizedVersion(version) === want) return version;
      options.onReachable?.(version);
    } catch (cause) {
      if (options.signal.aborted) throw aborted();
      options.onUnavailable?.(cause);
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new VersionCheckTimeoutError();
    await wait(Math.min(interval, remaining), options.signal);
  }
}
