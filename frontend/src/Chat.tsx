import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  applyEvent, cancelRun, createConversation, deleteConversation, fetchChatConfig, getConversation, isActive,
  listConversations, listenRun, removeAttachment, renameConversation, retryRun, startRun, uploadAttachment,
} from './chat-api';
import type { ChatState, Conversation } from './chat-api';
import { fetchMainModel, fetchProviders, mainModelOptions, setMainModel } from './ai-providers';
import type { MainModel } from './ai-providers';
import type { Post } from './feed';
import ChatMessage from './ChatMessage';
import ConversationDrawer from './ConversationDrawer';
import MediaViewer from './MediaViewer';
import { useBookmarks } from './Bookmarks';
import { usePageSession } from './page-session';
import { Icon } from './icons';

const SUGGESTIONS = ['找几张风景图', '看看我的收藏', 'cat 相关的标签有哪些', '推荐几张高分的插画'];
const MAX_IMAGES = 4;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

type Draft = { key: string; url: string; id?: string; error?: string };
type ModelOption = ReturnType<typeof mainModelOptions>[number];

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;

export default function Chat() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { open: openDetail } = usePageSession();
  const { clear: clearBookmarks } = useBookmarks();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [main, setMain] = useState<MainModel>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [viewer, setViewer] = useState<{ posts: Post[]; index: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const listening = useRef<AbortController | null>(null);
  const current = useRef(conversationId);
  const created = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const follow = useRef(true);
  const closeDrawer = useRef<(() => void) | null>(null);
  current.current = conversationId;

  const refreshList = useCallback(() => listConversations().then(setConversations).catch(() => {}), []);

  useEffect(() => {
    fetchChatConfig().then(data => setConfigured(data.configured)).catch(() => setConfigured(false));
    Promise.all([fetchProviders(), fetchMainModel()]).then(([providers, selected]) => { setModels(mainModelOptions(providers)); setMain(selected); }).catch(() => {});
    void refreshList();
  }, [refreshList]);

  // 订阅一轮任务的事件流；结束后重新拉取快照，保证与服务端一致。
  const listen = useCallback((cid: string, runId: string, after: number) => {
    listening.current?.abort();
    const controller = new AbortController();
    listening.current = controller;
    listenRun(cid, runId, after, event => {
      if (current.current !== cid) return;
      if (event.type === 'bookmark_changed') clearBookmarks();
      setState(prev => prev && prev.conversation.id === cid ? applyEvent(prev, event) : prev);
    }, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (controller.signal.aborted || current.current !== cid) return;
        getConversation(cid).then(snap => { if (current.current === cid) setState(snap); }).catch(() => {});
        void refreshList();
      });
  }, [clearBookmarks, refreshList]);

  useEffect(() => {
    listening.current?.abort();
    setError('');
    follow.current = true;
    if (!conversationId) { setState(null); return; }
    // 刚由首条消息创建并跳转过来的会话，状态已在本地，无需重新加载。
    if (created.current === conversationId) { created.current = null; return; }
    let active = true;
    setLoading(true);
    getConversation(conversationId)
      .then(snap => {
        if (!active) return;
        setState(snap);
        const last = snap.runs.at(-1);
        if (last && isActive(last.status)) listen(conversationId, last.id, snap.cursor);
      })
      .catch(err => { if (active) { setState(null); setError(err instanceof Error ? err.message : '会话加载失败'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [conversationId, listen]);

  useEffect(() => () => listening.current?.abort(), []);

  // 仅在用户停留在底部附近时跟随新内容滚动；上滚阅读时不打扰，并显示「回到底部」。
  useEffect(() => {
    const onScroll = () => { follow.current = nearBottom(); setAtBottom(follow.current); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (follow.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [state]);

  const lastRun = state?.runs.at(-1);
  const running = isActive(lastRun?.status);
  const uploading = drafts.some(item => !item.id && !item.error);
  const ready = drafts.filter(item => item.id).map(item => item.id!);
  const canSend = !sending && !running && !uploading && configured !== false && (text.trim() !== '' || ready.length > 0);

  const send = async (message: string = text) => {
    if (sending || running || uploading || (!message.trim() && !ready.length)) return;
    setSending(true);
    setError('');
    follow.current = true;
    const ids = message === text ? ready : [];
    try {
      let cid = conversationId;
      if (!cid) {
        const conversation = await createConversation();
        cid = conversation.id;
        created.current = cid;
        current.current = cid;
        setState({ conversation, messages: [], runs: [], calls: {}, cursor: 0 });
        navigate(`/chat/${encodeURIComponent(cid)}`, { replace: true });
      }
      // 乐观显示用户消息，等待服务端确认期间界面不空白。
      setState(prev => prev && {
        ...prev,
        messages: [...prev.messages, { id: -Date.now(), runId: 'pending', status: 'completed', role: 'user', blocks: [
          ...(message.trim() ? [{ type: 'text' as const, text: message }] : []),
          ...ids.map(attachmentId => ({ type: 'image' as const, attachmentId })),
        ] }],
        runs: [...prev.runs, { id: 'pending', status: 'pending' }],
      });
      if (message === text) { setText(''); setDrafts([]); drafts.forEach(item => URL.revokeObjectURL(item.url)); }
      const run = await startRun(cid, message, ids);
      const snap = await getConversation(cid);
      if (current.current !== cid) return;
      setState(snap);
      listen(cid, run.id, snap.cursor);
      void refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试');
      const cid = current.current;
      if (cid) getConversation(cid).then(setState).catch(() => {});
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const stop = () => { if (state && lastRun) void cancelRun(state.conversation.id, lastRun.id).catch(() => {}); };
  const retry = async () => {
    if (!state || !lastRun) return;
    const cid = state.conversation.id;
    setError('');
    try {
      const run = await retryRun(cid, lastRun.id);
      const snap = await getConversation(cid);
      setState(snap);
      listen(cid, run.id, snap.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
    }
  };

  const addFiles = (list: FileList | File[]) => {
    const images = Array.from(list).filter(file => ACCEPT.split(',').includes(file.type)).slice(0, MAX_IMAGES - drafts.length);
    if (!images.length) { if (list.length) setError('仅支持 JPEG、PNG、WebP 和静态 GIF 图片，每条最多 4 张。'); return; }
    for (const file of images) {
      const key = crypto.randomUUID();
      setDrafts(prev => [...prev, { key, url: URL.createObjectURL(file) }]);
      uploadAttachment(file)
        .then(attachment => setDrafts(prev => prev.map(item => item.key === key ? { ...item, id: attachment.id } : item)))
        .catch(err => setDrafts(prev => prev.map(item => item.key === key ? { ...item, error: err instanceof Error ? err.message : '上传失败' } : item)));
    }
  };
  const removeDraft = (draft: Draft) => {
    if (draft.id) void removeAttachment(draft.id).catch(() => {});
    URL.revokeObjectURL(draft.url);
    setDrafts(prev => prev.filter(item => item.key !== draft.key));
  };

  const resize = () => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };
  useLayoutEffect(resize, [text]);

  const changeModel = (value: string) => {
    const [providerId, modelId] = JSON.parse(value) as [string, string];
    setMain({ providerId, modelId });
    setMainModel({ providerId, modelId }).then(setMain).catch(err => setError(err instanceof Error ? err.message : '切换模型失败'));
  };

  const visible = state?.messages.filter(message => message.role === 'user' || message.role === 'assistant') ?? [];
  const lastAssistant = visible.at(-1)?.role === 'assistant' ? visible.at(-1) : undefined;
  const thinking = running && !(lastAssistant && lastAssistant.runId === lastRun?.id && lastAssistant.blocks.some(block => block.text || block.type === 'tool'));
  const title = state?.conversation.title || (conversationId ? '对话' : '新对话');
  const modelValue = main ? JSON.stringify([main.providerId, main.modelId]) : '';
  const empty = !loading && !visible.length;

  return <section className="chat" aria-label="AI 助手" data-empty={empty || undefined}>
    <header className="page-header chat-header">
      <h1>
        <button type="button" className="chat-title" aria-expanded={drawer} aria-controls="chat-conversations" aria-haspopup="dialog" title="会话列表"
          onClick={() => drawer ? closeDrawer.current?.() : setDrawer(true)}>
          <span>{title}</span><Icon name="chevron" />
        </button>
      </h1>
      <button type="button" className="icon-button chat-new" aria-label="新对话" title="新对话" disabled={!conversationId}
        onClick={() => navigate('/chat')}><Icon name="plus" /></button>
    </header>

    {drawer && <ConversationDrawer conversations={conversations} currentId={conversationId} closeRef={closeDrawer} onClose={() => setDrawer(false)}
      onSelect={id => navigate(id ? `/chat/${encodeURIComponent(id)}` : '/chat')}
      onRename={async (id, value) => {
        const updated = await renameConversation(id, value);
        setConversations(list => list.map(item => item.id === id ? { ...item, title: updated.title } : item));
        setState(prev => prev && prev.conversation.id === id ? { ...prev, conversation: { ...prev.conversation, title: updated.title } } : prev);
      }}
      onDelete={async id => {
        await deleteConversation(id);
        setConversations(list => list.filter(item => item.id !== id));
        if (id === conversationId) navigate('/chat', { replace: true });
      }} />}

    {loading ? <div className="chat-loading" role="status"><span className="spinner" aria-hidden="true" />正在加载对话…</div>
      : empty ? <div className="chat-empty">
        <span className="chat-empty-mark" aria-hidden="true"><Icon name="sparkle" /></span>
        {configured === false ? <>
          <h2>还没有可用的模型</h2>
          <p>先在设置中添加 AI 供应商并选择主模型，就可以开始对话。</p>
          <Link className="button primary" to="/settings?tab=settings-providers">去设置供应商</Link>
        </> : <>
          <h2>有什么可以帮你？</h2>
          <p>我可以搜索作品、查看收藏和标签，找到的作品会直接显示在对话里。</p>
          <ul className="chat-suggestions">
            {SUGGESTIONS.map(item => <li key={item}><button type="button" disabled={sending || configured !== true} onClick={() => void send(item)}>{item}</button></li>)}
          </ul>
        </>}
      </div> : <ol className="chat-messages" aria-live="polite" aria-busy={running}>
        {state!.runs.map(run => {
          const items = visible.filter(message => message.runId === run.id);
          const failed = run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
          return [
            run.omitted ? <li key={`${run.id}:trim`} className="chat-note">较早的 {run.omitted} 轮对话未纳入上下文</li> : null,
            ...items.map(message => <ChatMessage key={message.id} message={message} calls={state!.calls}
              streaming={isActive(run.status) && message.status === 'partial'}
              onView={(posts, index) => setViewer({ posts, index })} onDetail={openDetail} />),
            failed ? <li key={`${run.id}:fail`} className="chat-run-error" data-status={run.status}>
              <Icon name="alert" /><span>{run.status === 'cancelled' ? '已停止生成' : run.error || '对话失败'}</span>
              {run === lastRun && <button type="button" className="text-button" onClick={() => void retry()}><Icon name="retry" />重试</button>}
            </li> : null,
          ];
        })}
        {thinking && <li className="chat-thinking" role="status"><span /><span /><span /><span className="visually-hidden">正在思考</span></li>}
      </ol>}

    {error && <p className="setting-error chat-error" role="alert">{error}</p>}

    <form className="chat-composer" data-dragging={dragging || undefined}
      onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}
      onDragOver={(event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
      {!atBottom && !empty && <button type="button" className="chat-to-bottom" aria-label="回到底部" title="回到底部"
        onClick={() => { follow.current = true; window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); }}><Icon name="chevron" /></button>}
      {drafts.length > 0 && <ul className="chat-drafts">
        {drafts.map(item => <li key={item.key} data-state={item.error ? 'error' : item.id ? 'ready' : 'uploading'} title={item.error}>
          <img src={item.url} alt="待发送的图片" />
          {!item.id && !item.error && <span className="spinner" aria-label="上传中" />}
          {item.error && <span className="chat-draft-error"><Icon name="alert" /></span>}
          <button type="button" aria-label="移除图片" onClick={() => removeDraft(item)}><Icon name="close" /></button>
        </li>)}
      </ul>}
      <label htmlFor="chat-input" className="visually-hidden">输入消息</label>
      <textarea id="chat-input" ref={input} rows={1} value={text} placeholder={configured === false ? '请先在设置中配置模型' : '问点什么，或让我帮你找作品…'}
        disabled={configured === false} enterKeyHint="send"
        onChange={event => setText(event.target.value)}
        onPaste={(event: ClipboardEvent) => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
      <div className="chat-composer-bar">
        <input ref={files} type="file" accept={ACCEPT} multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
        <button type="button" className="icon-button" aria-label="添加图片" title="添加图片" disabled={drafts.length >= MAX_IMAGES || configured === false} onClick={() => files.current?.click()}><Icon name="attach" /></button>
        {models.length > 0 && <label className="chat-model">
          <span className="visually-hidden">模型</span>
          <select value={models.some(option => JSON.stringify([option.providerId, option.modelId]) === modelValue) ? modelValue : ''} onChange={event => changeModel(event.target.value)}>
            <option value="" disabled>选择模型</option>
            {models.map(option => <option key={option.label} value={JSON.stringify([option.providerId, option.modelId])}>{option.label}</option>)}
          </select>
          <Icon name="chevron" />
        </label>}
        {running
          ? <button type="button" className="chat-send stop" aria-label="停止生成" title="停止" onClick={stop}><Icon name="stop" /></button>
          : <button type="submit" className="chat-send" aria-label="发送" title="发送（Enter）" disabled={!canSend} aria-busy={sending}>
            {sending ? <span className="spinner" /> : <Icon name="send" />}
          </button>}
      </div>
    </form>

    {viewer && <MediaViewer posts={viewer.posts} start={viewer.index} onClose={() => setViewer(null)} />}
  </section>;
}
