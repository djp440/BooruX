import { expect, test } from "bun:test";
import { parseSSE } from "./chatApi";

test("SSE parser handles frames split across chunks", () => {
  const frames: string[] = [];
  const parser = parseSSE((frame) => frames.push(frame));
  parser.push('data: {"type":"text_delta"');
  parser.push(',"data":{"text":"你"}}\n\n');
  parser.push(': keepalive\n\n');
  parser.push('data: {"type":"run_finished"}\n\n');
  expect(frames).toEqual(['{"type":"text_delta","data":{"text":"你"}}', '{"type":"run_finished"}']);
});
