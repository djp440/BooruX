export type ChatMessage = {
  id: number;
  runId: string;
  status: string;
  role?: string;
  content?: string;
  blocks?: ChatBlock[];
};

export type ChatBlock = {
  type: string;
  text?: string;
  key?: string;
  attachmentId?: string;
  callId?: string;
};

export type ChatRun = {
  id: string;
  status: string;
  error?: string | null;
  providerName?: string;
  modelName?: string;
};

export type ChatAttachment = {
  id: string;
  mime: string;
  size: number;
  width: number;
  height: number;
};

export function runState(run?: ChatRun): { label: "running" | "failed" | "cancelled" | "completed"; canCancel: boolean; canRetry: boolean } {
  const status = run?.status ?? "";
  const active = status === "pending" || status === "running";
  const retryable = status === "failed" || status === "cancelled" || status === "interrupted";
  const label = active ? "running" : retryable ? (status === "cancelled" ? "cancelled" : "failed") : "completed";
  return { label, canCancel: active, canRetry: retryable };
}
