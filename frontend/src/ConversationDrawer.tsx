import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { exportURL, isActive } from './chat-api';
import type { Conversation } from './chat-api';
import { relativeTime } from './feed';
import { useHistoryLayer } from './history-layer';
import { Icon } from './icons';

type Props = {
  conversations: Conversation[];
  currentId?: string;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<string>; // 返回新会话 id
  onClose: () => void;
  // 页头的切换按钮通过它关闭下拉，以便同时回退历史记录。
  closeRef: MutableRefObject<(() => void) | null>;
};

// 会话列表：从页头下方展开的下拉抽屉，限定在内容列内；后退手势、Esc、点击遮罩或再次点击标题都会收起。
// 选择会话时先回退下拉的历史记录再跳转。
export default function ConversationDrawer({ conversations, currentId, onSelect, onRename, onDelete, onDuplicate, onClose, closeRef }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const after = useRef<(() => void) | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const finish = useCallback(() => {
    onClose();
    after.current?.();
    after.current = null;
  }, [onClose]);
  const close = useHistoryLayer(finish);

  closeRef.current = close;

  // 打开时把焦点移入列表（当前会话或「新对话」），关闭后归还给页头的切换按钮。
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[aria-current="page"], .chat-drawer-new')?.focus();
    return () => { closeRef.current = null; opener?.focus(); };
  }, [closeRef]);

  const pick = (id: string | null) => {
    after.current = () => onSelect(id);
    close();
  };

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setBusy('');
    }
  };

  const save = (id: string) => {
    const title = draft.trim();
    if (!title) return;
    void act(`rename:${id}`, async () => { await onRename(id, title); setEditing(null); });
  };

  return <div className="chat-drawer-anchor">
    <div className="chat-drawer-backdrop" aria-hidden="true" onClick={close} />
    <div ref={panel} id="chat-conversations" className="chat-drawer" role="dialog" aria-label="会话列表"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
      <button type="button" className="chat-drawer-new" onClick={() => pick(null)}><Icon name="plus" />新对话</button>
      {error && <p className="setting-error" role="alert">{error}</p>}
      {conversations.length ? <ul className="chat-drawer-list">
        {conversations.map(item => <li key={item.id} data-current={item.id === currentId || undefined}>
          {editing === item.id ? <form className="chat-drawer-rename" onSubmit={event => { event.preventDefault(); save(item.id); }}>
            <label htmlFor={`rename-${item.id}`} className="visually-hidden">会话标题</label>
            <input id={`rename-${item.id}`} value={draft} maxLength={100} autoFocus disabled={busy !== ''}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} />
            <button type="submit" className="icon-button" aria-label="保存标题" title="保存" disabled={!draft.trim() || busy !== ''}><Icon name="check" /></button>
          </form> : <>
            <button type="button" className="chat-drawer-item" aria-current={item.id === currentId ? 'page' : undefined} onClick={() => pick(item.id)}>
              <span className="chat-drawer-title">{item.title || '新对话'}</span>
              <span className="chat-drawer-meta">
                {isActive(item.status) && <span className="chat-live-dot" aria-label="运行中" />}
                {relativeTime(new Date(item.updatedAt))}
              </span>
            </button>
            {confirming === item.id ? <div className="chat-drawer-actions" aria-live="polite">
              <button type="button" className="text-button" onClick={() => setConfirming(null)}>取消</button>
              <button type="button" className="text-button danger" disabled={busy !== ''}
                onClick={() => void act(`delete:${item.id}`, async () => { await onDelete(item.id); setConfirming(null); })}>确认删除</button>
            </div> : <div className="chat-drawer-actions">
              <button type="button" className="icon-button" aria-label={`重命名 ${item.title}`} title="重命名" onClick={() => { setEditing(item.id); setDraft(item.title); setConfirming(null); }}><Icon name="edit" /></button>
              <button type="button" className="icon-button" aria-label={`复制 ${item.title}`} title="复制会话" disabled={busy !== ''}
                onClick={() => void act(`duplicate:${item.id}`, async () => pick(await onDuplicate(item.id)))}>
                {busy === `duplicate:${item.id}` ? <span className="spinner" /> : <Icon name="copy" />}
              </button>
              <a className="icon-button" href={exportURL(item.id)} download aria-label={`导出 ${item.title} 为 Markdown`} title="导出为 Markdown"><Icon name="download" /></a>
              <button type="button" className="icon-button" aria-label={`删除 ${item.title}`} title="删除" onClick={() => { setConfirming(item.id); setEditing(null); }}><Icon name="trash" /></button>
            </div>}
          </>}
        </li>)}
      </ul> : <p className="chat-drawer-empty">还没有会话，发送第一条消息开始吧。</p>}
    </div>
  </div>;
}
