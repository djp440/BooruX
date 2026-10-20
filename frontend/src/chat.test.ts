import { expect, test } from "bun:test";
import { runState } from "./chat";

test("active runs can be cancelled", () => {
  expect(runState({ id: "r", status: "running" })).toEqual({ label: "running", canCancel: true, canRetry: false });
});

test("failed and cancelled runs can be retried", () => {
  expect(runState({ id: "r", status: "failed" }).canRetry).toBe(true);
  expect(runState({ id: "r", status: "cancelled" })).toEqual({ label: "cancelled", canCancel: false, canRetry: true });
});
