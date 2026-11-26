import { apiGet } from './api';

export const PROXY_NOT_CONFIGURED_MSG = '尚未配置系统代理，请先前往「系统设置 → 下载代理」配置';

/**
 * Checks whether a system proxy is currently configured on the control plane.
 */
export async function isSystemProxyConfigured(): Promise<boolean> {
  const res = await apiGet('/api/v1/settings/proxy');
  return Boolean(res?.proxy?.configured);
}

/**
 * Validates enabling a system-proxy checkbox. When next is true, verifies that
 * the system proxy is configured first; otherwise reports the error and returns false.
 */
export async function canEnableSystemProxy(
  next: boolean,
  onError: (message: string) => void,
): Promise<boolean> {
  if (!next) return true;
  try {
    if (await isSystemProxyConfigured()) return true;
    onError(PROXY_NOT_CONFIGURED_MSG);
    return false;
  } catch (ex: any) {
    onError(ex?.message || '检查系统代理配置失败');
    return false;
  }
}
