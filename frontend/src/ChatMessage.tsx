import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { attachmentURL, resultPosts, toolSummary } from './chat-api';
import type { ChatMessage as Message, ToolCall } from './chat-api';
import type { Post } from './feed';
import { Icon } from './icons';

// 消息下方的操作：复制始终可用；其余按所处轮次的状态由 Chat 决定是否提供。
export type MessageActions = {
  sticky?: boolean; // 最后一轮的操作条常显，其余在悬停时显示
  onEdit?: (text: string) => Promise<boolean>; // 用户消息：编辑并重发，成功返回 true
  onRegenerate?: () => void;
  onBranch?: () => Promise<void>;
};

type Props = {
  message: Message;
  actions?: MessageActions;
  calls: Record<string, ToolCall>;
  streaming: boolean;
  onView: (posts: Post[], index: number) => void;
  onDetail: (id: string) => void;
  onQuote: (id: string, url: string) => void;
  quoted: string[];
};

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // 非安全上下文（如局域网 http 访问）没有 Clipboard API
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) resolve(); else reject(new Error('复制失败'));
  });
}

// 复制后 1.5 秒内 copied 为 true，用于把图标换成 ✓。
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [copied, text => {
    void copyText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }, () => {});
  }];
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, copy] = useCopy();
  return <div className="chat-code">
    <pre ref={ref}>{children}</pre>
    <button type="button" className="chat-code-copy" aria-label={copied ? '已复制' : '复制代码'} title={copied ? '已复制' : '复制'}
      onClick={() => copy(ref.current?.innerText ?? '')}><Icon name={copied ? 'check' : 'copy'} /></button>
  </div>;
}

// 不渲染原始 HTML；链接一律新窗口打开。
const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
  }}>{text}</Markdown>;
});

// 思考中自动展开、结束后自动收起；用户手动切换过则以用户为准。
function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(active);
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(active); }, [active]);
  if (!text.trim()) return null;
  return <details className="chat-reasoning" data-active={active || undefined} open={open}
    onToggle={event => {
      const next = event.currentTarget.open;
      if (next !== open) { touched.current = true; setOpen(next); }
    }}>
    <summary><Icon name="sparkle" /><span>{active ? '正在思考…' : '已思考'}</span><Icon name="chevron" /></summary>
    <p>{text}</p>
  </details>;
}

function ToolCard({ call, onView, onDetail, onQuote, quoted }: { call: ToolCall } & Pick<Props, 'onView' | 'onDetail' | 'onQuote' | 'quoted'>) {
  const [open, setOpen] = useState(false);
  const posts = resultPosts(call);
  const error = typeof call.result?.error === 'string' ? call.result.error : '';
  const status = call.status === 'running' || call.status === 'pending' ? 'running' : error || call.status === 'failed' ? 'failed' : 'completed';
  const tags = Array.isArray(call.result?.tags) ? call.result.tags as string[] : [];
  return <div className="chat-tool" data-status={status}>
    <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="chat-tool-status" aria-hidden="true">
        {status === 'running' ? <span className="spinner" /> : <Icon name={status === 'failed' ? 'alert' : 'check'} />}
      </span>
      <span className="chat-tool-title">{toolSummary(call)}</span>
      <span className="visually-hidden">{status === 'running' ? '进行中' : status === 'failed' ? '失败' : '完成'}</span>
      <Icon name="chevron" />
    </button>
    {error && <p className="chat-tool-error">{error}</p>}
    {tags.length > 0 && <ul className="chat-tool-tags">{tags.slice(0, 24).map(tag => <li key={tag}>#{tag}</li>)}</ul>}
    {posts.length > 0 && <ul className="chat-posts">
      {posts.slice(0, 20).map((post, index) => <li key={post.id}>
        <button type="button" className="chat-post" aria-label={`查看大图：${post.title || post.id}`} onClick={() => onView(posts, index)}>
          <img src={post.previewUrl || post.imageUrl} alt="" loading="lazy" decoding="async" onLoad={event => event.currentTarget.dataset.ready = ''} />
          {post.mediaType === 'video' && <span className="chat-post-badge">视频</span>}
        </button>
        <button type="button" className="chat-post-detail" onClick={() => onDetail(post.id)} aria-label={`打开 ${post.id} 详情`} title="打开详情"><Icon name="open" /></button>
        {quoted.includes(post.id)
          ? <span className="chat-post-quote" data-quoted="" title="已引用"><Icon name="check" /><span className="visually-hidden">已引用</span></span>
          : <button type="button" className="chat-post-quote" onClick={() => onQuote(post.id, post.previewUrl || post.imageUrl)} aria-label={`引用 ${post.id}`} title="引用到输入框"><Icon name="plus" /></button>}
      </li>)}
    </ul>}
    {open && <div className="chat-tool-detail">
      <p>参数</p>
      <pre>{call.arguments || '{}'}</pre>
      {call.result && <><p>结果</p><pre>{JSON.stringify(call.result, null, 2).slice(0, 4000)}</pre></>}
    </div>}
  </div>;
}

function ActionBar({ text, actions, onStartEdit }: { text: string; actions: MessageActions; onStartEdit?: () => void }) {
  const [copied, copy] = useCopy();
  const [branching, setBranching] = useState(false);
  const { onRegenerate, onBranch } = actions;
  return <div className="chat-actions" data-sticky={actions.sticky || undefined}>
    <button type="button" className="icon-button" aria-label={copied ? '已复制' : '复制'} title={copied ? '已复制' : '复制'} disabled={!text} onClick={() => copy(text)}>
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
    {onStartEdit && <button type="button" className="icon-button" aria-label="编辑并重发" title="编辑并重发" onClick={onStartEdit}><Icon name="edit" /></button>}
    {onRegenerate && <button type="button" className="icon-button" aria-label="重新生成" title="重新生成（使用当前模型）" onClick={onRegenerate}><Icon name="retry" /></button>}
    {onBranch && <button type="button" className="icon-button" aria-label="从此分支" title="从此分支为新会话" disabled={branching} aria-busy={branching}
      onClick={() => { setBranching(true); void onBranch().finally(() => setBranching(false)); }}>
      {branching ? <span className="spinner" /> : <Icon name="branch" />}
    </button>}
  </div>;
}

function UserMessage({ message, onDetail, actions }: Pick<Props, 'message' | 'onDetail' | 'actions'>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('') || message.content || '';
  const images = message.blocks.filter(block => block.type === 'image' && block.attachmentId);
  const posts = message.blocks.filter(block => block.type === 'post' && block.key);
  const submit = async () => {
    setSaving(true);
    const ok = await actions?.onEdit?.(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return <li className="chat-message user">
    {images.length + posts.length > 0 && <div className="chat-user-images">
      {posts.map(block => <button key={block.key} type="button" className="chat-user-quote" title={`引用 ${block.key}`} aria-label={`打开引用作品 ${block.key} 详情`} onClick={() => onDetail(block.key!)}>
        <img src={block.text} alt="" loading="lazy" /><span>引用</span>
      </button>)}
      {images.map(block => <img key={block.attachmentId} src={attachmentURL(block.attachmentId!)} alt="附加的图片" loading="lazy" />)}
    </div>}
    {editing ? <form className="chat-edit" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor={`edit-${message.id}`} className="visually-hidden">编辑消息</label>
      <textarea id={`edit-${message.id}`} value={draft} autoFocus disabled={saving} rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
          else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
      <div className="chat-edit-actions">
        <button type="button" className="text-button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
        <button type="submit" className="button primary" aria-busy={saving} disabled={saving || (!draft.trim() && images.length + posts.length === 0)}>
          {saving ? <span className="spinner" aria-label="发送中" /> : '重发'}
        </button>
      </div>
    </form> : text && <p className="chat-bubble">{text}</p>}
    {actions && !editing && <ActionBar text={text} actions={actions} onStartEdit={actions.onEdit && (() => { setDraft(text); setEditing(true); })} />}
  </li>;
}

export default function ChatMessage({ message, actions, calls, streaming, onView, onDetail, onQuote, quoted }: Props) {
  if (message.role === 'user') return <UserMessage message={message} onDetail={onDetail} actions={actions} />;
  const blocks = message.blocks.length ? message.blocks : message.content ? [{ type: 'text' as const, text: message.content }] : [];
  const lastIndex = blocks.length - 1;
  return <li className="chat-message assistant">
    {blocks.map((block, index) => {
      const active = streaming && index === lastIndex;
      if (block.type === 'reasoning') return <Reasoning key={index} text={block.text ?? ''} active={active} />;
      if (block.type === 'tool') {
        // 模型已发起调用但工具尚未开始执行时，先用消息里的 tool_calls 显示等待状态。
        const raw = message.tool_calls?.find(item => item.id === block.callId);
        const call = block.callId ? calls[block.callId] ?? (raw && { callId: raw.id, name: raw.function.name, arguments: raw.function.arguments, status: 'pending' }) : undefined;
        return call ? <ToolCard key={block.callId} call={call} onView={onView} onDetail={onDetail} onQuote={onQuote} quoted={quoted} /> : null;
      }
      if (block.type === 'text' && block.text) return <div key={index} className="chat-markdown" data-streaming={active || undefined}><MarkdownText text={block.text} /></div>;
      return null;
    })}
    {actions && !streaming && <ActionBar text={blocks.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n\n')} actions={actions} />}
  </li>;
}
