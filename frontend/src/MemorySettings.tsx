import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  MEMORY_LIMIT_RANGE, addMemory, clearMemories, deleteMemory, fetchMemories, memoryUsage, saveMemorySettings, updateMemory,
} from './ai-memory';
import type { MemoryState } from './ai-memory';
import { Icon } from './icons';

export default function MemorySettings() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [limitDraft, setLimitDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    try {
      const next = await fetchMemories();
      setState(next);
      setLimitDraft(String(next.limit));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '记忆加载失败');
    }
  };
  useEffect(() => { void load(); }, []);

  // 统一的操作包装：互斥、反馈、完成后刷新。
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: done });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : '操作失败，请重试', error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div className="setting-item">
    {loadError
      ? <p className="setting-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => void load()}>重试</button></p>
      : <p className="filter-empty">正在加载记忆…</p>}
  </div>;

  const limit = Number(limitDraft);
  const limitValid = Number.isInteger(limit) && limit >= MEMORY_LIMIT_RANGE.min && limit <= MEMORY_LIMIT_RANGE.max;
  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(() => addMemory(draft.trim()).then(() => setDraft('')), '已添加记忆。');
  };

  return <div className="setting-item" aria-labelledby="memory-heading">
    <div className="setting-row">
      <div>
        <h3 id="memory-heading">记忆</h3>
        <p>助手会记住你的稳定偏好（如喜欢的标签、回复风格），也可以在对话中让它记住或忘掉。关闭后不再使用也不再写入，已有记忆会保留。</p>
      </div>
      <input type="checkbox" role="switch" className="switch" aria-label="启用记忆" checked={state.enabled} disabled={busy}
        onChange={event => void run(() => saveMemorySettings({ aiMemoryEnabled: event.target.checked }), event.target.checked ? '记忆已开启。' : '记忆已关闭。')} />
    </div>

    <div className="setting-row">
      <div>
        <h4>已用 {memoryUsage(state)}</h4>
        <p>调低上限不会删除已有记忆，但降到上限以内前无法新增。</p>
      </div>
      <form className="setting-row-actions" onSubmit={event => { event.preventDefault(); void run(() => saveMemorySettings({ aiMemoryLimit: limit }), '字数上限已保存。'); }}>
        <label htmlFor="memory-limit" className="visually-hidden">记忆总字数上限</label>
        <input id="memory-limit" type="number" inputMode="numeric" min={MEMORY_LIMIT_RANGE.min} max={MEMORY_LIMIT_RANGE.max} value={limitDraft}
          onChange={event => setLimitDraft(event.target.value)} aria-invalid={!limitValid} />
        <button type="submit" className="button" disabled={busy || !limitValid || limit === state.limit}>保存上限</button>
      </form>
    </div>

    {state.memories.length ? <ul className="memory-list" aria-label="记忆条目">
      {state.memories.map(memory => <li key={memory.id}>
        {editing?.id === memory.id ? <form onSubmit={event => { event.preventDefault(); void run(() => updateMemory(memory.id, editing.text.trim()).then(() => setEditing(null)), '记忆已更新。'); }}>
          <label htmlFor={`memory-${memory.id}`} className="visually-hidden">编辑记忆</label>
          <textarea id={`memory-${memory.id}`} rows={2} value={editing.text} onChange={event => setEditing({ id: memory.id, text: event.target.value })} disabled={busy} />
          <div className="setting-actions">
            <button type="submit" className="button primary" disabled={busy || !editing.text.trim()}>保存</button>
            <button type="button" className="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
          </div>
        </form> : <>
          <div>
            <p>{memory.text}</p>
            <small>{memory.source === 'user' ? '你添加' : '助手记录'} · {memory.updatedAt.slice(0, 10)}</small>
          </div>
          <div className="setting-row-actions">
            <button type="button" className="icon-button" aria-label="编辑记忆" title="编辑" disabled={busy} onClick={() => setEditing({ id: memory.id, text: memory.text })}><Icon name="edit" /></button>
            <button type="button" className="icon-button" aria-label="删除记忆" title="删除" disabled={busy} onClick={() => void run(() => deleteMemory(memory.id), '记忆已删除。')}><Icon name="trash" /></button>
          </div>
        </>}
      </li>)}
    </ul> : <p className="filter-empty">还没有记忆。</p>}

    <form className="filter-input" onSubmit={submitAdd}>
      <label htmlFor="memory-new" className="visually-hidden">添加记忆</label>
      <input id="memory-new" value={draft} onChange={event => setDraft(event.target.value)} placeholder="手动添加一条记忆，例如：回复尽量简短" autoComplete="off" disabled={busy} />
      <button type="submit" className="button" disabled={busy || !draft.trim()}>添加</button>
    </form>

    {state.memories.length > 0 && <div className="setting-actions">
      {confirmClear ? <>
        <button type="button" className="button danger" disabled={busy} onClick={() => void run(() => clearMemories().then(() => setConfirmClear(false)), '记忆已清空。')}>确认清空</button>
        <button type="button" className="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
      </> : <button type="button" className="button" disabled={busy} onClick={() => setConfirmClear(true)}>清空全部记忆</button>}
    </div>}
    {message && <p className={message.error ? 'setting-error' : 'setting-notice'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </div>;
}
