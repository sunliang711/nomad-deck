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
