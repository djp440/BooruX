// AI 供应商：对接 server-go/ai_routes.go。密钥只写不读，后端仅返回 hasKey。
// 模型以 manual 区分：manual=1 为已加入，manual=0 且 available=1 为拉取到的候选。
export type Protocol = 'openai' | 'openai-responses';
export type Model = { id: string; name: string; manual: number; available: number };
export type Provider = { id: string; name: string; baseUrl: string; protocol: Protocol; hasKey: boolean; discoveryError: string | null; models: Model[] };
export type ProviderInput = { name: string; baseUrl: string; protocol: Protocol; apiKey?: string; clearKey?: boolean };
export type MainModel = { providerId: string; modelId: string } | null;

export const PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'Chat Completions' },
  { value: 'openai-responses', label: 'Responses' },
] as const;

const CANDIDATE_LIMIT = 100;

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请重试');
  return data as T;
}

const base = (id: string) => `/api/ai/providers/${encodeURIComponent(id)}`;
const withModels = (data: { provider: Omit<Provider, 'models'>; models: Model[] }): Provider => ({ ...data.provider, models: data.models });

export const fetchProviders = () => request<{ providers: Provider[] }>('/api/ai/providers').then(data => data.providers);
export const createProvider = (input: ProviderInput) => request<Parameters<typeof withModels>[0]>('/api/ai/providers', 'POST', input).then(withModels);
export const updateProvider = (id: string, input: ProviderInput) => request<Parameters<typeof withModels>[0]>(base(id), 'PUT', input).then(withModels);
export const deleteProvider = (id: string) => request(base(id), 'DELETE');
export const refreshModels = (id: string) => request<Parameters<typeof withModels>[0]>(`${base(id)}/models/refresh`, 'POST').then(withModels);
export const addModel = (id: string, modelId: string) => request<{ models: Model[] }>(`${base(id)}/models`, 'PUT', { id: modelId }).then(data => data.models);
export const removeModel = (id: string, modelId: string) => request<{ models: Model[] }>(`${base(id)}/models/${encodeURIComponent(modelId)}`, 'DELETE').then(data => data.models);

// 连通性测试：后端向模型发送一条短消息（Reply with ok.），返回回复与耗时。
export async function testModel(id: string, modelId: string): Promise<string> {
  const data = await request<{ value: string; latencyMs: number; reply: string; error?: string }>(`${base(id)}/models/verify`, 'POST', { id: modelId, capability: 'chat' })
    .catch((error: Error) => { throw new Error(`${modelId} 连通失败：${error.message}`); });
  if (data.value !== 'supported') throw new Error(`${modelId} 未返回内容：${data.error || '请检查模型是否支持对话'}`);
  return `${modelId} 连通正常，耗时 ${(data.latencyMs / 1000).toFixed(1)} 秒，回复：${data.reply}`;
}

// 主模型复用对话的模型选择（ai_chats.selection）。
const readMain = (data: { selection?: { providerId?: string | null; modelId?: string | null } }): MainModel =>
  data.selection?.providerId && data.selection.modelId ? { providerId: data.selection.providerId, modelId: data.selection.modelId } : null;
export const fetchMainModel = () => request<Parameters<typeof readMain>[0]>('/api/profiles/default/chat').then(readMain);
export const setMainModel = (main: MainModel) => request<Parameters<typeof readMain>[0]>('/api/profiles/default/chat', 'PUT', main ?? { providerId: '', modelId: '' }).then(readMain);

// 推理强度与后端 reasoningEfforts 一致；空值表示不发送，由供应商决定。
export const EFFORT_OPTIONS = [
  { value: '', label: '默认' }, { value: 'none', label: '关闭' }, { value: 'minimal', label: '极简' }, { value: 'low', label: '低' },
  { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '极高' }, { value: 'max', label: '最大' },
] as const;
type Effort = { selection?: { reasoningEffort?: string } };
const readEffort = (data: Effort) => data.selection?.reasoningEffort ?? '';
export const fetchReasoningEffort = () => request<Effort>('/api/profiles/default/chat').then(readEffort);
export const setReasoningEffort = (main: NonNullable<MainModel>, effort: string) =>
  request<Effort>('/api/profiles/default/chat', 'PUT', { ...main, reasoningEffort: effort }).then(readEffort);

export const addedModels = (provider: Provider) => provider.models.filter(model => model.manual === 1);

export function candidateModels(provider: Provider, query: string): Model[] {
  const needle = query.trim().toLowerCase();
  return provider.models
    .filter(model => model.manual !== 1 && model.available === 1 && (!needle || model.id.toLowerCase().includes(needle)))
    .slice(0, CANDIDATE_LIMIT);
}

export const mainModelOptions = (providers: Provider[]) => providers.flatMap(provider =>
  addedModels(provider).map(model => ({ providerId: provider.id, modelId: model.id, label: `${provider.name} / ${model.name}` })));
