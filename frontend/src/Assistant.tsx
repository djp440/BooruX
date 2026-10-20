import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { runState, type ChatAttachment, type ChatMessage, type ChatRun } from "./chat";
import { cancelRun, clearChat, getChat, getProviders, listenRun, retryRun, selectModel, startRun, uploadAttachment, type Model } from "./chatApi";
import { applyChatEvent } from "./events";
import type { Messages } from "./i18n";
import { Shell } from "./Shell";

type Props = { t: Messages; profileId: string };

export function Assistant(props: Props) {
  return <AssistantView key={props.profileId} {...props} />;
}

function AssistantView({ t, profileId }: Props) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["chat", profileId], queryFn: () => getChat(profileId) });
  const providers = useQuery({ queryKey: ["ai-providers"], queryFn: getProviders, enabled: query.data?.configured === true });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [run, setRun] = useState<ChatRun>();
  const [cursor, setCursor] = useState(0);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const files = useRef<File[]>([]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!query.data || messages.length > 0) return;
    setMessages(query.data.messages ?? []);
    setCursor(query.data.cursor ?? 0);
  }, [query.data, messages.length]);

  const selection = query.data?.selection;
  const models = providers.data?.flatMap((provider) => (provider.models ?? []).filter((model) => model.chat !== "unsupported")) ?? [];
  const selectedModel = models.find((model) => model.providerId === selection?.providerId && model.id === selection?.modelId);
  const ready = query.data?.configured === true && Boolean(selectedModel);

  const selectionMutation = useMutation({
    mutationFn: (model: Model) => selectModel(profileId, model.providerId, model.id),
    onSuccess: (data) => {
      queryClient.setQueryData(["chat", profileId], data);
      setError("");
    },
    onError: (err) => setError(err.message),
  });


  const follow = async (nextRun: ChatRun) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let eventCursor = cursor;
    try {
      await listenRun(profileId, nextRun.id, eventCursor, (event) => {
        eventCursor = Math.max(eventCursor, event.id);
        setCursor(eventCursor);
        setMessages((current) => applyChatEvent(current, event));
        if (event.type === "run_finished") {
          setRun(undefined);
          queryClient.invalidateQueries({ queryKey: ["chat", profileId] });
        }
        if (event.type === "run_failed") {
          setRun((prev) => prev ? { ...prev, status: String(event.data.status ?? "failed"), error: String(event.data.error ?? t.chatFailed) } : prev);
          controller.abort();
        }
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t.chatFailed);
    }
  };

  const send = async (retry?: ChatRun) => {
    if (!ready) return;
    setError("");
    try {
      let nextRun: ChatRun;
      if (retry) {
        setMessages((current) => current.filter((message) => !(message.runId === retry.id && message.status === "partial")));
        nextRun = await retryRun(profileId, retry.id);
      } else {
        const uploaded: ChatAttachment[] = [];
        for (const file of files.current) uploaded.push(await uploadAttachment(profileId, file));
        files.current = [];
        setAttachments([]);
        if (!text.trim() && uploaded.length === 0) return;
        nextRun = await startRun(profileId, text, uploaded.map((a) => a.id));
        setMessages((current) => [...current, { id: -Date.now(), runId: nextRun.id, status: "completed", role: "user", content: text }]);
        setText("");
      }
      setRun(nextRun);
      await follow(nextRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.chatFailed);
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      await cancelRun(profileId, run.id);
      abort.current?.abort();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.chatFailed);
    }
  };

  const clear = async () => {
    if (!window.confirm(t.clearConfirm)) return;
    try {
      await clearChat(profileId);
      setMessages([]);
      setRun(undefined);
      setCursor(0);
      setAttachments([]);
      files.current = [];
    } catch (err) {
      setError(err instanceof Error ? err.message : t.chatFailed);
    }
  };

  if (query.isLoading) return <AssistantShell t={t}><p className="empty-panel">{t.loading}</p></AssistantShell>;
  if (query.isError) return <AssistantShell t={t}><p className="empty-panel">{t.profileMissing}</p></AssistantShell>;
  if (!query.data?.configured) return <AssistantShell t={t}>
    <section className="empty-panel assistant-empty">
      <h2>{t.assistantUnconfigured}</h2>
      <p>{t.assistantUnconfiguredBody}</p>
      <Link className="primary-link" to="/settings">{t.openSettings}</Link>
    </section>
  </AssistantShell>;

  const retryable = run && runState(run).canRetry;
  const canSend = ready && !run && (text.trim().length > 0 || attachments.length > 0);

  return <AssistantShell t={t}>
    <section className="assistant-panel" aria-label={t.assistant}>
      <div className="assistant-toolbar">
        <label className="model-select"><span>{t.model}</span><select aria-label={t.model} value={selectedModel ? selectedModel.providerId + ":" + selectedModel.id : ""} disabled={selectionMutation.isPending} onChange={(event) => {
          const [providerId, ...rest] = event.target.value.split(":");
          const model = models.find((item) => item.providerId === providerId && item.id === rest.join(":"));
          if (model) selectionMutation.mutate(model);
        }}>
          <option value="">{t.chooseModel}</option>
          {models.map((model) => <option key={model.providerId + ":" + model.id} value={model.providerId + ":" + model.id}>{model.name || model.id}</option>)}
        </select></label>
        <button type="button" className="text-button" onClick={() => void clear()}>{t.clearChat}</button>
      </div>
      {!ready && <div className="assistant-notice"><p>{t.chooseModelBody}</p>{providers.isLoading && <p>{t.loading}</p>}{providers.isError && <p role="alert">{t.chatFailed}</p>}</div>}
      <div className="message-list" aria-live="polite">
        {messages.length === 0 && ready && <p className="assistant-hint">{t.assistantReadyBody}</p>}
        {messages.map((message) => <article className={"message message-" + (message.role ?? "assistant")} key={message.id}>
          {renderContent(message, profileId)}
          {message.status === "partial" && <span className="typing">…</span>}
        </article>)}
      </div>
      {run && <div className="run-actions">
        <span role="status">{t.generating}</span>
        <button type="button" className="text-button" onClick={() => void stop()}>{t.stop}</button>
      </div>}
      {retryable && <button type="button" className="primary-link retry-button" onClick={() => void send(run)}>{t.retry}</button>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {ready && <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="attachment-button" title={t.attach}>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => {
            files.current = Array.from(event.target.files ?? []).slice(0, 4);
            setAttachments(files.current.map((file, i) => ({ id: "pending-" + i, mime: file.type, size: file.size, width: 0, height: 0 })));
          }} />
          <span aria-hidden="true">＋</span><span className="sr-only">{t.attach}</span>
        </label>
        <textarea aria-label={t.messagePlaceholder} placeholder={t.messagePlaceholder} value={text} onChange={(event) => setText(event.target.value)} maxLength={8000} rows={2} />
        <button type="submit" className="send-button" disabled={!canSend}>{t.send}</button>
        {attachments.length > 0 && <p className="attachment-count">{attachments.length}/{t.attachmentsMax}</p>}
      </form>}
    </section>
  </AssistantShell>;
}

function renderContent(message: ChatMessage, profileId: string) {
  if (message.blocks?.length) {
    return message.blocks.map((block, i) => {
      if (block.type === "image" && block.attachmentId) return <img key={i} className="message-image" src={"/api/profiles/" + encodeURIComponent(profileId) + "/chat/attachments/" + encodeURIComponent(block.attachmentId)} alt="" />;
      if (block.type === "text" && block.text) return <p key={i}>{block.text}</p>;
      return null;
    });
  }
  return <p>{message.content}</p>;
}

function AssistantShell({ t, children }: { t: Messages; children: React.ReactNode }) {
  return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{t.assistant}</h1></div>{children}</Shell>;
}
