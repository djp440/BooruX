import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  PROTOCOL_OPTIONS, addModel, addedModels, candidateModels, createProvider, deleteProvider, fetchMainModel, fetchProviders,
  mainModelOptions, refreshModels, removeModel, setMainModel, testModel, updateProvider,
} from './ai-providers';
import type { MainModel, Protocol, Provider, ProviderInput } from './ai-providers';
import { Icon } from './icons';

type Feedback = { scope: string; text: string; error?: boolean } | null;

function ProviderForm({ initial, busy, onSubmit, onCancel }: {
  initial?: Provider; busy: boolean; onSubmit: (input: ProviderInput) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const prefix = initial ? `provider-${initial.id}` : 'provider-new';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // 编辑时密钥留空表示不修改。
    onSubmit({ name: name.trim(), baseUrl: baseUrl.trim(), protocol, ...(apiKey ? { apiKey } : {}), ...(clearKey ? { clearKey } : {}) });
  };
  return <form className="provider-form" onSubmit={submit} aria-label={initial ? `编辑 ${initial.name}` : '添加供应商'}>
    <fieldset disabled={busy}>
      <label htmlFor={`${prefix}-name`}>名称</label>
      <input id={`${prefix}-name`} required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如 OpenAI" autoComplete="off" />
      <label htmlFor={`${prefix}-url`}>API 地址</label>
      <input id={`${prefix}-url`} required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} />
      <label htmlFor={`${prefix}-key`}>API 密钥</label>
      <input id={`${prefix}-key`} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={clearKey}
        placeholder={initial?.hasKey ? '已保存，留空则不修改' : '可选'} autoComplete="off" spellCheck={false} />
      {initial?.hasKey && <label className="provider-check"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的密钥</label>}
      <label htmlFor={`${prefix}-protocol`}>接口协议</label>
      <select id={`${prefix}-protocol`} value={protocol} onChange={event => setProtocol(event.target.value as Protocol)}>
        {PROTOCOL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </fieldset>
    <div className="setting-actions">
      <button type="submit" className="button primary" disabled={busy || !name.trim() || !baseUrl.trim()}>{busy ? '保存中…' : initial ? '保存' : '添加并拉取模型'}</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}

export default function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [main, setMain] = useState<MainModel>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // busy 记录正在进行的操作，形如 "refresh:<id>"，同一时间只允许一个。
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [queries, setQueries] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    Promise.all([fetchProviders(), fetchMainModel()])
      .then(([list, selected]) => { if (active) { setProviders(list); setMain(selected); } })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : '供应商加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  const run = async (key: string, scope: string, action: () => Promise<string | void>) => {
    setBusy(key);
    setFeedback(null);
    setConfirming(null);
    try {
      const text = await action();
      if (text) setFeedback({ scope, text });
    } catch (error) {
      setFeedback({ scope, text: error instanceof Error ? error.message : '操作失败，请重试', error: true });
    } finally {
      setBusy('');
    }
  };

  const replace = (next: Provider) => setProviders(list => list.some(item => item.id === next.id) ? list.map(item => item.id === next.id ? next : item) : [...list, next]);
  const setModels = (id: string, models: Provider['models']) => setProviders(list => list.map(item => item.id === id ? { ...item, models } : item));
  const discovered = (provider: Provider) => provider.discoveryError
    ? { error: true, text: `拉取模型失败：${provider.discoveryError}` }
    : { text: `已拉取 ${provider.models.filter(model => model.available === 1).length} 个模型。` };

  const removeFromMain = (providerId: string, modelId?: string) => {
    if (main?.providerId === providerId && (!modelId || main.modelId === modelId)) setMain(null);
  };

  const message = (scope: string) => feedback?.scope === scope &&
    <p className={feedback.error ? 'setting-error' : 'setting-notice'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>;

  if (loading) return <div className="setting-item"><div className="setting-loading" role="status"><span className="spinner" aria-hidden="true" />正在加载供应商…</div></div>;
  if (loadError) return <div className="setting-item"><p className="setting-error" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p></div>;

  const options = mainModelOptions(providers);
  const mainValue = main ? JSON.stringify([main.providerId, main.modelId]) : '';
  const mainKnown = options.some(option => option.providerId === main?.providerId && option.modelId === main?.modelId);

  return <>
    <div className="setting-item">
      <div>
        <h3 id="main-model-heading">主模型</h3>
        <p>从所有供应商已加入的模型中选择一个，作为默认使用的模型。</p>
      </div>
      <select className="provider-select" aria-labelledby="main-model-heading" value={mainKnown ? mainValue : ''} disabled={!options.length || busy !== ''}
        onChange={event => {
          const value = event.target.value ? JSON.parse(event.target.value) as [string, string] : null;
          void run('main', 'main', async () => {
            setMain(await setMainModel(value && { providerId: value[0], modelId: value[1] }));
            return value ? '主模型已更新。' : '已取消主模型。';
          });
        }}>
        <option value="" disabled={!main}>{options.length ? '未设置' : '先在下方供应商中加入模型'}</option>
        {options.map(option => <option key={option.label + option.modelId} value={JSON.stringify([option.providerId, option.modelId])}>{option.label}</option>)}
      </select>
      {main && mainKnown && <div className="setting-actions">
        <button type="button" className="button" disabled={busy !== ''} onClick={() => void run(`test:${main.providerId}:${main.modelId}`, 'main', () => testModel(main.providerId, main.modelId))}>
          {busy === `test:${main.providerId}:${main.modelId}` ? '测试中…' : '测试连通性'}
        </button>
      </div>}
      {message('main')}
    </div>

    {providers.map(provider => {
      const added = addedModels(provider);
      const query = queries[provider.id] ?? '';
      const candidates = candidateModels(provider, query);
      const custom = query.trim();
      const canAddCustom = custom && !provider.models.some(model => model.id === custom && model.manual === 1) && !candidates.some(model => model.id === custom);
      const working = busy !== '';
      return <div key={provider.id} className="setting-item provider-card">
        <div className="setting-row">
          <div>
            <h3>{provider.name}</h3>
            <p className="provider-meta">{provider.baseUrl} · {PROTOCOL_OPTIONS.find(option => option.value === provider.protocol)?.label} · {provider.hasKey ? '已保存密钥' : '无密钥'}</p>
          </div>
          <div className="setting-row-actions" aria-live="polite">
            {confirming === provider.id ? <>
              <button type="button" className="button" onClick={() => setConfirming(null)}>取消</button>
              <button type="button" className="button danger" disabled={working} onClick={() => void run(`delete:${provider.id}`, 'list', async () => {
                await deleteProvider(provider.id);
                setProviders(list => list.filter(item => item.id !== provider.id));
                removeFromMain(provider.id);
                return `已删除 ${provider.name}。`;
              })}>确认删除</button>
            </> : <>
              <button type="button" className="button" disabled={working} aria-expanded={editing === provider.id} onClick={() => setEditing(editing === provider.id ? null : provider.id)}>编辑</button>
              <button type="button" className="button" disabled={working} onClick={() => setConfirming(provider.id)}>删除</button>
            </>}
          </div>
        </div>

        {editing === provider.id && <ProviderForm initial={provider} busy={busy === `save:${provider.id}`} onCancel={() => setEditing(null)}
          onSubmit={input => void run(`save:${provider.id}`, provider.id, async () => {
            const saved = await updateProvider(provider.id, input);
            replace(saved);
            setEditing(null);
            return '供应商已保存。';
          })} />}

        <div className="provider-section">
          <h4>已加入的模型</h4>
          {added.length ? <ul className="filter-tags">
            {added.map(model => <li key={model.id}>
              <span>{model.name}</span>
              {main?.providerId === provider.id && main.modelId === model.id && <span className="model-badge">主模型</span>}
              <button type="button" className="model-test" aria-label={`测试 ${model.id} 连通性`} disabled={working}
                onClick={() => void run(`test:${provider.id}:${model.id}`, provider.id, () => testModel(provider.id, model.id))}>
                {busy === `test:${provider.id}:${model.id}` ? '测试中…' : '测试'}
              </button>
              <button type="button" aria-label={`移除 ${model.id}`} title="移除" disabled={working} onClick={() => void run(`remove:${provider.id}`, provider.id, async () => {
                setModels(provider.id, await removeModel(provider.id, model.id));
                removeFromMain(provider.id, model.id);
              })}><Icon name="close" /></button>
            </li>)}
          </ul> : <p className="filter-empty">尚未加入模型，可从下方拉取的列表中选择。</p>}
        </div>

        <div className="provider-section">
          <div className="setting-row">
            <h4>可选模型</h4>
            <button type="button" className="button provider-refresh" disabled={working} onClick={() => void run(`refresh:${provider.id}`, provider.id, async () => {
              const next = await refreshModels(provider.id);
              replace(next);
              const result = discovered(next);
              if (result.error) throw new Error(result.text);
              return result.text;
            })}>{busy === `refresh:${provider.id}` ? '拉取中…' : '拉取模型'}</button>
          </div>
          <div className="filter-input">
            <label htmlFor={`models-${provider.id}`} className="visually-hidden">筛选或输入模型 ID</label>
            <input id={`models-${provider.id}`} type="search" value={query} placeholder="筛选模型，或输入模型 ID 手动加入" autoComplete="off" spellCheck={false}
              onChange={event => setQueries({ ...queries, [provider.id]: event.target.value })} />
            {canAddCustom && <button type="button" className="button" disabled={working} onClick={() => void run(`add:${provider.id}`, provider.id, async () => {
              setModels(provider.id, await addModel(provider.id, custom));
              setQueries({ ...queries, [provider.id]: '' });
              return `已加入 ${custom}。`;
            })}>手动加入</button>}
          </div>
          {candidates.length ? <ul className="model-candidates" aria-label={`${provider.name} 的可选模型`}>
            {candidates.map(model => <li key={model.id}>
              <span>{model.name}</span>
              <button type="button" className="text-button" disabled={working} aria-label={`加入 ${model.id}`} onClick={() => void run(`add:${provider.id}`, provider.id, async () => {
                setModels(provider.id, await addModel(provider.id, model.id));
              })}>加入</button>
            </li>)}
          </ul> : <p className="filter-empty">{query ? '没有匹配的模型。' : provider.discoveryError ? `拉取模型失败：${provider.discoveryError}` : '暂无可选模型，点击「拉取模型」获取。'}</p>}
        </div>
        {message(provider.id)}
      </div>;
    })}

    <div className="setting-item">
      {editing === 'new' ? <ProviderForm busy={busy === 'create'} onCancel={() => setEditing(null)}
        onSubmit={input => void run('create', 'list', async () => {
          const created = await createProvider(input);
          replace(created);
          setEditing(null);
          const result = discovered(created);
          return `已添加 ${created.name}。${result.text}`;
        })} /> : <div className="setting-row">
        <div>
          <h3>{providers.length ? '添加供应商' : '尚未添加供应商'}</h3>
          <p>支持兼容 OpenAI 接口的服务，添加后会自动拉取模型列表。</p>
        </div>
        <div className="setting-row-actions">
          <button type="button" className="button" disabled={busy !== ''} onClick={() => setEditing('new')}>添加</button>
        </div>
      </div>}
      {message('list')}
    </div>
  </>;
}
