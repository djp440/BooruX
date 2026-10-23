import { useEffect, useState } from 'react';

const RANGE = { min: 8000, max: 1000000, fallback: 128000 } as const;

// 对话上下文字符预算：超出后较早的对话轮次不再发送给模型。
export default function ContextSettings() {
  const [saved, setSaved] = useState<number>(RANGE.fallback);
  const [draft, setDraft] = useState(String(RANGE.fallback));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    void fetch('/api/settings?profileId=default').then(response => response.json()).then(data => {
      const value = Number(data.settings?.aiContextLimit);
      if (Number.isInteger(value)) { setSaved(value); setDraft(String(value)); }
    }).catch(() => undefined);
  }, []);

  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= RANGE.min && value <= RANGE.max;
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/settings?profileId=default', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiContextLimit: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.error || '保存失败，请重试');
      setSaved(value);
      setMessage({ text: '上下文上限已保存，下一次对话生效。' });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : '保存失败，请重试', error: true });
    } finally {
      setBusy(false);
    }
  };

  return <form className="setting-item" aria-labelledby="context-heading" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="setting-row">
      <div>
        <h3 id="context-heading">对话上下文上限</h3>
        <p>每次发送给助手的对话字符预算（含系统提示、记忆和历史），默认 128000。超出后较早的对话轮次不再纳入，对话输入框旁会显示当前占用。范围 {RANGE.min}–{RANGE.max}。</p>
      </div>
      <div className="setting-row-actions">
        <label htmlFor="context-limit" className="visually-hidden">对话上下文字符上限</label>
        <input id="context-limit" type="number" inputMode="numeric" min={RANGE.min} max={RANGE.max} step={1000} value={draft} disabled={busy}
          onChange={event => setDraft(event.target.value)} aria-invalid={!valid} />
        <button type="submit" className="button" disabled={busy || !valid || value === saved}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </div>
    {message && <p className={message.error ? 'setting-error' : 'setting-notice'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </form>;
}
