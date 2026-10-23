// AI 记忆：对接 server-go/ai_memory.go；开关与总字数上限存放在 profile 设置里。
export type Memory = { id: string; text: string; source: 'assistant' | 'user'; createdAt: string; updatedAt: string };
export type MemoryState = { enabled: boolean; limit: number; used: number; memories: Memory[] };

export const MEMORY_LIMIT_RANGE = { min: 200, max: 10000 } as const;
const url = '/api/profiles/default/chat/memories';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || '请求失败，请重试');
  return data as T;
}

export const fetchMemories = () => request<MemoryState>(url);
export const addMemory = (text: string) => request(url, 'POST', { text });
export const updateMemory = (id: string, text: string) => request(`${url}/${encodeURIComponent(id)}`, 'PATCH', { text });
export const deleteMemory = (id: string) => request(`${url}/${encodeURIComponent(id)}`, 'DELETE');
export const clearMemories = () => request(url, 'DELETE');
export const saveMemorySettings = (settings: { aiMemoryEnabled?: boolean; aiMemoryLimit?: number }) =>
  request('/api/settings?profileId=default', 'PUT', settings);

export const memoryUsage = (state: MemoryState) => `${state.used} / ${state.limit} 字`;
