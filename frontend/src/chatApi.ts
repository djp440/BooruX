import type { ChatAttachment, ChatMessage, ChatRun } from "./chat";
import type { ChatEvent } from "./events";

export type Provider = { id: string; name: string; hasKey: boolean; models?: Model[] };
export type Model = { providerId: string; id: string; name: string; chat?: string; reasoningSummary?: number };

export type ChatSnapshot = {
  configured: boolean;
  selection?: { providerId?: string; modelId?: string; reasoningEffort?: string };
  messages?: ChatMessage[];
  runs?: ChatRun[];
  cursor?: number;
};

type ProviderResponse = { providers?: Provider[] };
type RunResponse = { run?: ChatRun };
type AttachmentResponse = { attachment?: ChatAttachment };

const base = (profileId: string) => "/api/profiles/" + encodeURIComponent(profileId) + "/chat";

export async function getChat(profileId: string): Promise<ChatSnapshot> {
  const response = await fetch(base(profileId));
  if (!response.ok) throw new Error("无法加载 AI 助手");
  return response.json();
}

export async function getProviders(): Promise<Provider[]> {
  const response = await fetch("/api/ai/providers");
  if (!response.ok) throw new Error("无法加载 AI Provider");
  return ((await response.json()) as ProviderResponse).providers ?? [];
}

export async function selectModel(profileId: string, providerId: string, modelId: string): Promise<ChatSnapshot> {
  return request(base(profileId), { method: "PUT", body: JSON.stringify({ providerId, modelId }) });
}

export async function uploadAttachment(profileId: string, file: File): Promise<ChatAttachment> {
  const response = await fetch(base(profileId) + "/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as AttachmentResponse & { error?: string };
  if (!response.ok || !body.attachment) throw new Error(body.error || "上传图片失败");
  return body.attachment;
}

export async function startRun(profileId: string, text: string, attachmentIds: string[] = []): Promise<ChatRun> {
  const body = await request<RunResponse>(base(profileId) + "/runs", {
    method: "POST",
    body: JSON.stringify({ text, attachmentIds, requestId: crypto.randomUUID() }),
  });
  if (!body.run) throw new Error("无法开始对话");
  return body.run;
}

export async function cancelRun(profileId: string, runId: string): Promise<void> {
  await request(base(profileId) + "/runs/" + encodeURIComponent(runId) + "/cancel", { method: "POST" });
}

export async function retryRun(profileId: string, runId: string): Promise<ChatRun> {
  const body = await request<RunResponse>(base(profileId) + "/runs/" + encodeURIComponent(runId) + "/retry", { method: "POST" });
  if (!body.run) throw new Error("无法重试对话");
  return body.run;
}

export async function clearChat(profileId: string): Promise<void> {
  await request(base(profileId), { method: "DELETE" });
}

export function listenRun(profileId: string, runId: string, after: number, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  return fetch(base(profileId) + "/runs/" + encodeURIComponent(runId) + "/events?after=" + after, { signal }).then(async (response) => {
    if (!response.ok || !response.body) throw new Error("无法订阅对话");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = parseSSE((frame) => {
      try {
        onEvent(JSON.parse(frame) as ChatEvent);
      } catch {
        // 单个坏帧不应中断整轮对话。
      }
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  });
}

export function parseSSE(onData: (data: string) => void): { push: (chunk: string) => void } {
  let buffer = "";
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) onData(data.join("\n"));
    data = [];
  };
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line === "") {
          flush();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    },
  };
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}
