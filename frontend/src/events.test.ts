import { expect, test } from "bun:test";
import { applyChatEvent, type ChatEvent } from "./events";

const event = (type: string, data: Record<string, unknown>): ChatEvent => ({ id: 1, runId: "run-1", type, data });

test("text deltas append to a streaming assistant message", () => {
  const next = applyChatEvent([], event("text_delta", { messageId: 7, text: "你" }));
  expect(next).toEqual([{ id: 7, runId: "run-1", status: "partial", role: "assistant", content: "你" }]);
});

test("completed messages replace the streamed placeholder", () => {
  const next = applyChatEvent(
    [{ id: 7, runId: "run-1", status: "partial", role: "assistant", content: "你" }],
    event("message_completed", { messageId: 7, message: { role: "assistant", content: "你好" } }),
  );
  expect(next).toEqual([{ id: 7, runId: "run-1", status: "completed", role: "assistant", content: "你好" }]);
});

test("run failure is surfaced without dropping the conversation", () => {
  const next = applyChatEvent([{ id: 7, runId: "run-1", status: "partial", content: "你" }], event("run_failed", { error: "鉴权失败" }));
  expect(next[0]?.content).toBe("你");
  expect(next.at(-1)?.role).toBe("system");
  expect(next.at(-1)?.content).toBe("鉴权失败");
});
