import type { ChatMessage } from "./chat";

export type ChatEvent = {
  id: number;
  runId: string;
  type: string;
  data: Record<string, unknown>;
};

type Completion = { role?: string; content?: string; blocks?: ChatMessage["blocks"] };

export function applyChatEvent(messages: ChatMessage[], event: ChatEvent): ChatMessage[] {
  const data = event.data;
  switch (event.type) {
    case "text_delta": {
      const id = Number(data.messageId);
      const current = messages.find((m) => m.id === id)?.content ?? "";
      return upsert(messages, { id, runId: event.runId, status: "partial", role: "assistant", content: current + String(data.text ?? "") });
    }
    case "reasoning_delta":
      return messages;
    case "message_completed": {
      const completion = (data.message ?? {}) as Completion;
      return upsert(messages, {
        id: Number(data.messageId),
        runId: event.runId,
        status: "completed",
        role: completion.role ?? "assistant",
        content: completion.content ?? "",
        blocks: completion.blocks,
      });
    }
    case "run_failed": {
      const error = String(data.error ?? "对话失败，请重试");
      if (messages.at(-1)?.content === error && messages.at(-1)?.role === "system") return messages;
      return [...messages, { id: -Date.now(), runId: event.runId, status: "failed", role: "system", content: error }];
    }
    case "tool_started": {
      const name = String(data.name ?? "工具");
      return upsert(messages, {
        id: stableID(event.runId, "tool-" + String(data.callId ?? name)),
        runId: event.runId,
        status: "partial",
        role: "system",
        content: "正在执行 " + name + "…",
      });
    }
    case "tool_finished": {
      const name = String(data.name ?? "工具");
      const failed = data.status === "failed";
      return upsert(messages, {
        id: stableID(event.runId, "tool-" + String(data.callId ?? name)),
        runId: event.runId,
        status: failed ? "failed" : "completed",
        role: "system",
        content: failed ? name + " 执行失败" : name + " 已完成",
      });
    }
    case "context_trimmed":
      return [...messages, { id: -Date.now(), runId: event.runId, status: "completed", role: "system", content: "为控制上下文，已省略较早的对话。" }];
    default:
      return messages;
  }
}

function upsert(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === next.id);
  return at < 0 ? [...messages, next] : messages.map((m, i) => (i === at ? next : m));
}

function stableID(runId: string, key: string): number {
  let n = 0;
  for (const ch of runId + key) n = (n * 31 + ch.charCodeAt(0)) | 0;
  return n === 0 ? -1 : n;
}
