import { memo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { attachmentURL, resultPosts, toolSummary } from './chat-api';
import type { ChatMessage as Message, ToolCall } from './chat-api';
import type { Post } from './feed';
import { Icon } from './icons';

type Props = {
  message: Message;
  calls: Record<string, ToolCall>;
  streaming: boolean;
  onView: (posts: Post[], index: number) => void;
  onDetail: (id: string) => void;
};

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="chat-code">
    <pre ref={ref}>{children}</pre>
    <button type="button" className="chat-code-copy" aria-label={copied ? '已复制' : '复制代码'} title={copied ? '已复制' : '复制'}
      onClick={() => {
        void navigator.clipboard?.writeText(ref.current?.innerText ?? '').then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}><Icon name={copied ? 'check' : 'copy'} /></button>
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

function Reasoning({ text, active }: { text: string; active: boolean }) {
  return <details className="chat-reasoning" data-active={active || undefined}>
    <summary><Icon name="sparkle" /><span>{active ? '正在思考…' : '已思考'}</span><Icon name="chevron" /></summary>
    <p>{text}</p>
  </details>;
}

function ToolCard({ call, onView, onDetail }: { call: ToolCall; onView: Props['onView']; onDetail: Props['onDetail'] }) {
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
      </li>)}
    </ul>}
    {open && <div className="chat-tool-detail">
      <p>参数</p>
      <pre>{call.arguments || '{}'}</pre>
      {call.result && <><p>结果</p><pre>{JSON.stringify(call.result, null, 2).slice(0, 4000)}</pre></>}
    </div>}
  </div>;
}

export default function ChatMessage({ message, calls, streaming, onView, onDetail }: Props) {
  if (message.role === 'user') {
    const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('') || message.content || '';
    const images = message.blocks.filter(block => block.type === 'image' && block.attachmentId);
    return <li className="chat-message user">
      {images.length > 0 && <div className="chat-user-images">
        {images.map(block => <img key={block.attachmentId} src={attachmentURL(block.attachmentId!)} alt="附加的图片" loading="lazy" />)}
      </div>}
      {text && <p className="chat-bubble">{text}</p>}
    </li>;
  }
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
        return call ? <ToolCard key={block.callId} call={call} onView={onView} onDetail={onDetail} /> : null;
      }
      if (block.type === 'text' && block.text) return <div key={index} className="chat-markdown" data-streaming={active || undefined}><MarkdownText text={block.text} /></div>;
      return null;
    })}
  </li>;
}
