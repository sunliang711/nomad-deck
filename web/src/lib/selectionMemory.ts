export const JOB_CENTER_CLUSTER_KEY = 'nd_job_center_cluster_id';
export const NOMAD_CLUSTER_KEY = 'nd_nomad_cluster_id';
export const VAULT_CLUSTER_KEY = 'nd_vault_cluster_id';

export function readStoredSelection(key: string): string {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function writeStoredSelection(key: string, value: string): void {
  if (!value) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 无痕模式等场景忽略存储异常。
  }
}

/** 根据 URL 参数、当前状态、上次记住的 ID 与集群列表决定最终选中集群。 */
export function resolveClusterSelection(
  list: Array<{ id: string }>,
  queryId: string,
  prevId: string,
  storedId: string,
): string {
  if (list.length === 0) return '';
  const has = (id: string) => Boolean(id && list.some((c) => c.id === id));
  if (has(queryId)) return queryId;
  if (has(prevId)) return prevId;
  if (has(storedId)) return storedId;
  return list[0].id;
}

export type JobCenterTab = 'list' | 'builder' | 'templates';

/** 根据 URL 查询参数解析 Job 中心当前激活的顶层标签页。 */
export function resolveJobCenterTab(params: URLSearchParams): JobCenterTab {
  const from = params.get('from') || '';
  const tab = params.get('tab') || '';
  const job = params.get('job') || '';
  if (from === 'integration') return 'builder';
  if (tab === 'templates') return 'templates';
  if (tab === 'builder') return 'builder';
  if (tab === 'runtime' || tab === 'list') return 'list';
  return job ? 'builder' : 'list';
}

/** 根据合法标签列表与默认标签，从 URL 查询参数解析当前标签。 */
export function resolveTabParam<T extends string>(
  params: URLSearchParams,
  validTabs: readonly T[],
  defaultTab: T,
): T {
  const tab = params.get('tab') || '';
  return (validTabs as readonly string[]).includes(tab) ? (tab as T) : defaultTab;
}

/** 构造同步标签页状态后的新 URLSearchParams，保持其它参数不变。 */
export function buildTabSearchParams(
  current: URLSearchParams,
  nextTab: string,
  defaultTab: string,
  options?: { deleteKeys?: string[]; extra?: Record<string, string> },
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of options?.deleteKeys || []) {
    next.delete(key);
  }
  if (nextTab === defaultTab) {
    next.delete('tab');
  } else {
    next.set('tab', nextTab);
  }
  if (options?.extra) {
    for (const [k, v] of Object.entries(options.extra)) {
      if (v) next.set(k, v);
    }
  }
  return next;
}
