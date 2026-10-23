// AI 对话：对接 server-go/ai_routes.go 的会话接口；事件流为 SSE，按事件 id 去重并续传。
import type { Post } from './feed';

export type ChatBlock = { type: 'text' | 'reasoning' | 'image' | 'tool'; text?: string; key?: string; attachmentId?: string; callId?: string };
export type ChatMessage = {
  id: number; runId: string; status: string; role: 'user' | 'assistant' | 'tool' | 'system'; content?: string; blocks: ChatBlock[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
export type ChatRun = { id: string; status: string; error?: string | null; modelName?: string; providerName?: string; omitted?: number };
export type ToolCall = { callId: string; runId?: string; name: string; arguments: string; status: string; result?: Record<string, unknown> | null };
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string; status?: string | null };
export type ChatState = { conversation: Conversation; messages: ChatMessage[]; runs: ChatRun[]; calls: Record<string, ToolCall>; cursor: number };
export type ChatEvent = { id: number; runId: string; type: string; data: Record<string, unknown> };
export type Attachment = { id: string; mime: string; size: number; width: number; height: number };

const PROFILE = '/api/profiles/default';
const conversations = `${PROFILE}/conversations`;
const conv = (id: string) => `${conversations}/${encodeURIComponent(id)}`;

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

export const isActive = (status?: string | null) => status === 'pending' || status === 'running';

export const fetchChatConfig = () => request<{ configured: boolean }>(`${PROFILE}/chat`);
export const listConversations = () => request<{ conversations: Conversation[] }>(conversations).then(data => data.conversations);
export const createConversation = () => request<{ conversation: Conversation }>(conversations, 'POST').then(data => data.conversation);
export const renameConversation = (id: string, title: string) => request<{ conversation: Conversation }>(conv(id), 'PATCH', { title }).then(data => data.conversation);
export const deleteConversation = (id: string) => request(conv(id), 'DELETE');
export const startRun = (id: string, text: string, attachmentIds: string[]) =>
  request<{ run: ChatRun }>(`${conv(id)}/runs`, 'POST', { text, attachmentIds, requestId: crypto.randomUUID() }).then(data => data.run);
export const cancelRun = (id: string, runId: string) => request(`${conv(id)}/runs/${encodeURIComponent(runId)}/cancel`, 'POST');
export const retryRun = (id: string, runId: string) => request<{ run: ChatRun }>(`${conv(id)}/runs/${encodeURIComponent(runId)}/retry`, 'POST').then(data => data.run);
export const attachmentURL = (id: string) => `${PROFILE}/chat/attachments/${encodeURIComponent(id)}`;
export const removeAttachment = (id: string) => request(attachmentURL(id), 'DELETE');

export async function uploadAttachment(file: Blob): Promise<Attachment> {
  const response = await fetch(`${PROFILE}/chat/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.attachment) throw new Error(data.error || '上传图片失败');
  return data.attachment;
}

type RawCall = { callId: string; runId: string; name: string; arguments: string; status: string; result: Record<string, unknown> | null };

export async function getConversation(id: string): Promise<ChatState> {
  const data = await request<{ conversation: Conversation; messages: ChatMessage[]; runs: ChatRun[]; calls: RawCall[]; cursor: number }>(conv(id));
  const calls: Record<string, ToolCall> = {};
  for (const call of data.calls) calls[call.callId] = call;
  return { conversation: data.conversation, messages: data.messages, runs: data.runs, calls, cursor: data.cursor };
}

export function parseSSE(onData: (data: string) => void): { push: (chunk: string) => void } {
  let buffer = '';
  let data: string[] = [];
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line === '') {
          if (data.length) onData(data.join('\n'));
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    },
  };
}

// 订阅一轮任务的事件；任务结束后服务端关闭连接，Promise 随之完成。
export async function listenRun(id: string, runId: string, after: number, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${conv(id)}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { signal });
  if (!response.ok || !response.body) throw new Error('无法连接对话');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = parseSSE(frame => {
    try { onEvent(JSON.parse(frame)); } catch { /* 单个坏帧不中断整轮对话 */ }
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.push(decoder.decode(value, { stream: true }));
  }
}

// 与后端 appendBlock 一致：同类型同 key 的相邻增量合并。
function appendBlock(blocks: ChatBlock[], type: ChatBlock['type'], text: string, key: string): ChatBlock[] {
  const last = blocks.at(-1);
  if (last && last.type === type && (last.key ?? '') === key) return [...blocks.slice(0, -1), { ...last, text: (last.text ?? '') + text }];
  return [...blocks, { type, text, key }];
}

const patchRun = (runs: ChatRun[], id: string, patch: Partial<ChatRun>) => runs.map(run => run.id === id ? { ...run, ...patch } : run);

export function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  if (event.id <= state.cursor) return state;
  const next = { ...state, cursor: event.id };
  const data = event.data ?? {};
  switch (event.type) {
    case 'text_delta':
    case 'reasoning_delta': {
      const id = Number(data.messageId);
      const type = event.type === 'text_delta' ? 'text' : 'reasoning';
      const existing = state.messages.find(message => message.id === id);
      const base: ChatMessage = existing ?? { id, runId: event.runId, status: 'partial', role: 'assistant', blocks: [] };
      const updated = { ...base, blocks: appendBlock(base.blocks, type, String(data.text ?? ''), String(data.key ?? '')) };
      return { ...next, messages: existing ? state.messages.map(message => message.id === id ? updated : message) : [...state.messages, updated] };
    }
    case 'message_completed': {
      const id = Number(data.messageId);
      const message = data.message as Partial<ChatMessage> | undefined;
      const completed: ChatMessage = { id, runId: event.runId, status: 'completed', role: 'assistant', ...message, blocks: message?.blocks ?? [] };
      const exists = state.messages.some(item => item.id === id);
      return { ...next, messages: exists ? state.messages.map(item => item.id === id ? completed : item) : [...state.messages, completed] };
    }
    case 'tool_started':
    case 'tool_finished': {
      const callId = String(data.callId);
      const previous = state.calls[callId];
      const call: ToolCall = event.type === 'tool_started'
        ? { callId, runId: event.runId, name: String(data.name), arguments: String(data.arguments ?? ''), status: 'running' }
        : { ...previous, callId, runId: event.runId, name: String(data.name), arguments: previous?.arguments ?? '', status: String(data.status), result: data.result as ToolCall['result'] };
      return { ...next, calls: { ...state.calls, [callId]: call } };
    }
    case 'context_trimmed':
      return { ...next, runs: patchRun(state.runs, event.runId, { omitted: Number(data.omitted) }) };
    case 'run_finished':
      return { ...next, runs: patchRun(state.runs, event.runId, { status: 'completed' }) };
    case 'run_failed':
      return { ...next, runs: patchRun(state.runs, event.runId, { status: String(data.status ?? 'failed'), error: String(data.error ?? '对话失败') }) };
    default:
      return next;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

// 工具卡片标题，例如「搜索作品 · cat · 12 个结果」。
export function toolSummary(call: ToolCall): string {
  const args = parseArgs(call.arguments);
  const result = call.result ?? {};
  const count = (list: unknown, unit: string) => Array.isArray(list) ? ` · ${list.length} ${unit}` : '';
  switch (call.name) {
    case 'search_posts': return `搜索作品${args.tags ? ` · ${args.tags}` : ''}${count(result.posts, '个结果')}`;
    case 'get_post': return `读取作品 ${args.id ?? ''}`.trim();
    case 'list_bookmarks': return `查看收藏${count(result.posts, '个作品')}`;
    case 'search_tags': return `查询标签 · ${args.query ?? ''}${count(result.tags, '个标签')}`;
    case 'set_bookmark': return `${args.bookmarked === false ? '取消收藏' : '收藏'} ${args.id ?? ''}`.trim();
    default: return call.name;
  }
}

type CompactPost = { id: string; title?: string; artist?: string; imageUrl?: string; previewUrl?: string; mediaType?: string; isBookmarked?: boolean; tags?: string[] };

// 工具结果中的作品转换为 Post，供缩略图网格与媒体查看器使用。
export function resultPosts(call: ToolCall): (Post & { previewUrl?: string })[] {
  const result = call.result ?? {};
  const list = (Array.isArray(result.posts) ? result.posts : result.post ? [result.post] : []) as CompactPost[];
  return list.filter(post => post?.id).map(post => ({
    id: post.id, title: post.title ?? '', artist: post.artist, imageUrl: post.imageUrl ?? '', previewUrl: post.previewUrl,
    mediaType: post.mediaType ?? 'image', parentId: null, hasChildren: false, isBookmarked: post.isBookmarked,
    tags: (post.tags ?? []).map(name => ({ id: name, name, category: 'general' })),
  }));
}
