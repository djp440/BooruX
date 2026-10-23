import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RATING_OPTIONS, TAG_FILTER_MAX, THEME_OPTIONS, applyTheme, fetchSettings, normalizeFilterTag, saveSettings } from './rating-settings';
import type { Rating, TagFilter, Theme } from './rating-settings';
import { usePageSession } from './page-session';
import { useBookmarks } from './Bookmarks';
import { clearPostsCache, postsCacheSize } from './post-cache';
import { clearSearchHistory, readSearchHistory } from './search';
import { Icon } from './icons';
import ContextSettings from './ContextSettings';
import MemorySettings from './MemorySettings';
import ProviderSettings from './ProviderSettings';

type Scope = 'theme' | 'rating' | 'tags' | 'history' | 'cache';

const GROUPS = [
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-content', label: '内容' },
  { id: 'settings-providers', label: '供应商' },
  { id: 'settings-data', label: '数据与存储' },
  { id: 'settings-about', label: '关于' },
] as const;

const EMPTY_FILTER: TagFilter = { blacklistEnabled: false, blacklist: [] };
const sameFilter = (a: TagFilter, b: TagFilter) => a.blacklistEnabled === b.blacklistEnabled && a.blacklist.join(' ') === b.blacklist.join(' ');

// 每次只展示当前标签页对应的分组；草稿状态保存在 Settings 中，切换标签不会丢失。
function Group({ index, active, children }: { index: number; active: number; children: ReactNode }) {
  if (index !== active) return null;
  const { id, label } = GROUPS[index];
  return <section id={id} className="setting-group" role="tabpanel" aria-labelledby={`${id}-tab`} tabIndex={-1}>
    <h2 className="visually-hidden">{label}</h2>
    <div className="setting-group-body">{children}</div>
  </section>;
}

export default function Settings() {
  const { invalidate } = usePageSession();
  const { clear: clearBookmarks } = useBookmarks();
  const [rating, setRating] = useState<Rating>('general');
  const [draft, setDraft] = useState<Rating>('general');
  const [theme, setTheme] = useState<Theme>('system');
  const [themeDraft, setThemeDraft] = useState<Theme>('system');
  const [tagFilter, setTagFilter] = useState<TagFilter>(EMPTY_FILTER);
  const [tagsDraft, setTagsDraft] = useState<TagFilter>(EMPTY_FILTER);
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [retrySave, setRetrySave] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState('');
  // 保存提示就近显示在触发它的设置项内。
  const [scope, setScope] = useState<Scope>('theme');
  const [attempt, setAttempt] = useState(0);
  const [historyCount, setHistoryCount] = useState(() => readSearchHistory().length);
  const [cacheSize, setCacheSize] = useState(() => postsCacheSize());
  const [confirming, setConfirming] = useState<'history' | 'cache' | null>(null);
  // 支持 /settings?tab=settings-providers 这类直达链接。
  const [tab, setTab] = useState(() => Math.max(0, GROUPS.findIndex(group => group.id === new URLSearchParams(window.location?.search).get('tab'))));
  const tabsRef = useRef<HTMLDivElement>(null);

  const selectTab = (next: number, focus = false) => {
    setTab(next);
    setConfirming(null);
    if (focus) tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const themeFormRef = useRef<HTMLFormElement>(null);
  const ratingFormRef = useRef<HTMLFormElement>(null);
  const savedThemeRef = useRef(theme);

  useEffect(() => {
    savedThemeRef.current = theme;
  }, [theme]);

  // 用户未保存离开设置页时（组件卸载），自动回滚 DOM 外观至已保存的主题
  useEffect(() => {
    return () => {
      applyTheme(savedThemeRef.current, false);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    fetchSettings(controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setRating(value.rating);
        setDraft(value.rating);
        setTheme(value.themeMode);
        setThemeDraft(value.themeMode);
        setTagFilter(value.tagFilter);
        setTagsDraft(value.tagFilter);
        savedThemeRef.current = value.themeMode;
        applyTheme(value.themeMode, true);
      })
      .catch(value => {
        if (!controller.signal.aborted) setLoadError(value instanceof Error ? value.message : '设置加载失败，请重试');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const resetFeedback = (next: Scope) => {
    setScope(next);
    setNotice('');
    setSaveError('');
    setRetrySave(null);
  };

  // 年龄分级与标签屏蔽影响所有已加载内容：作废列表、搜索结果、详情和评论，并清理旧缓存。
  const dropLoadedContent = () => {
    invalidate();
    clearBookmarks();
    clearPostsCache();
    setCacheSize(0);
  };

  const saveRating = async () => {
    setSaving('rating');
    resetFeedback('rating');
    try {
      await saveSettings({ rating: draft });
      setRating(draft);
      dropLoadedContent();
      setNotice('年龄分级已保存；返回首页或收藏时将按新分级重新加载。');
    } catch (value) {
      setSaveError(value instanceof Error ? value.message : '年龄分级保存失败，请重试');
      setRetrySave(() => () => void saveRating());
    } finally {
      setSaving('');
    }
  };

  const saveTheme = async () => {
    const previous = theme;
    setSaving('theme');
    resetFeedback('theme');
    try {
      await saveSettings({ themeMode: themeDraft });
      setTheme(themeDraft);
      savedThemeRef.current = themeDraft;
      applyTheme(themeDraft, true);
      setNotice('背景色已保存。');
    } catch (value) {
      applyTheme(previous, false);
      setThemeDraft(previous);
      setSaveError(value instanceof Error ? value.message : '背景色保存失败，请重试');
      setRetrySave(() => () => void saveTheme());
    } finally {
      setSaving('');
    }
  };

  const saveTags = async () => {
    setSaving('tags');
    resetFeedback('tags');
    try {
      await saveSettings({ tagFilter: tagsDraft });
      setTagFilter(tagsDraft);
      dropLoadedContent();
      setNotice('标签屏蔽已保存；返回首页或收藏时将重新加载。');
    } catch (value) {
      setSaveError(value instanceof Error ? value.message : '标签屏蔽保存失败，请重试');
      setRetrySave(() => () => void saveTags());
    } finally {
      setSaving('');
    }
  };

  const cancelTheme = () => {
    setThemeDraft(theme);
    applyTheme(theme, false);
    resetFeedback('theme');
    const target = themeFormRef.current?.querySelector<HTMLInputElement>(`input[value="${theme}"]`);
    target?.focus();
  };

  const cancelRating = () => {
    setDraft(rating);
    resetFeedback('rating');
    const target = ratingFormRef.current?.querySelector<HTMLInputElement>(`input[value="${rating}"]`);
    target?.focus();
  };

  // 支持一次输入多个以空格分隔的标签；规整、去重，并限制总数。
  const addTags = () => {
    const added = tagInput.split(/[\s,，]+/).map(normalizeFilterTag).filter(Boolean);
    if (!added.length) return;
    const blacklist = [...new Set([...tagsDraft.blacklist, ...added])].slice(0, TAG_FILTER_MAX);
    setTagsDraft({ ...tagsDraft, blacklist });
    setTagInput('');
    resetFeedback('tags');
  };

  const clearData = (target: 'history' | 'cache') => {
    if (confirming !== target) { setConfirming(target); return; }
    setConfirming(null);
    resetFeedback(target);
    if (target === 'history') {
      clearSearchHistory();
      setHistoryCount(0);
      setNotice('搜索历史已清空。');
    } else {
      clearPostsCache();
      invalidate();
      setCacheSize(0);
      setNotice('本地缓存已清除；返回列表时将重新加载。');
    }
  };

  const feedback = (target: Scope) => scope === target && <>
    {saveError && <p className="setting-error" role="alert">{saveError}{retrySave && <button type="button" className="text-button" onClick={retrySave}>重试</button>}</p>}
    {notice && <p className="setting-notice" role="status">{notice}</p>}
  </>;

  const tagsDirty = !sameFilter(tagsDraft, tagFilter);

  return <section className="settings" aria-label="设置">
    <header className="page-header"><h1>设置</h1></header>
    <div ref={tabsRef} className="settings-nav" role="tablist" aria-label="设置分组"
      onKeyDown={event => {
        // 方向键在标签间移动（WAI-ARIA tabs 模式），Home/End 跳到首尾。
        const keys: Record<string, number> = { ArrowLeft: tab - 1, ArrowRight: tab + 1, Home: 0, End: GROUPS.length - 1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        selectTab((keys[event.key] + GROUPS.length) % GROUPS.length, true);
      }}>
      {GROUPS.map((group, index) => <button key={group.id} id={`${group.id}-tab`} type="button" role="tab"
        aria-selected={tab === index} aria-controls={group.id} tabIndex={tab === index ? 0 : -1}
        onClick={() => selectTab(index)}>{group.label}</button>)}
    </div>
    {loadError && <p className="setting-error setting-load-error" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {loading ? <div className="setting-loading" role="status"><span className="spinner" aria-hidden="true" />正在加载设置…</div> : <>
      <Group index={0} active={tab}>
        <form ref={themeFormRef} className="setting-item" aria-labelledby="theme-heading" onSubmit={event => { event.preventDefault(); void saveTheme(); }}>
          <div>
            <h3 id="theme-heading">背景色</h3>
            <p>选择界面外观；跟随系统会随设备设置自动切换。</p>
          </div>
          <fieldset className="theme-options" disabled={saving === 'theme'}>
            <legend className="visually-hidden">选择背景色</legend>
            {THEME_OPTIONS.map(option => <label key={option.value} className="rating-option theme-option">
              <span className="theme-swatch" data-preview={option.value} aria-hidden="true" />
              <input type="radio" name="themeMode" value={option.value} checked={themeDraft === option.value} onChange={() => { setThemeDraft(option.value); applyTheme(option.value, false); resetFeedback('theme'); }} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>)}
          </fieldset>
          {feedback('theme')}
          <div className="setting-actions">
            <button type="submit" className="button primary" disabled={saving !== '' || themeDraft === theme}>{saving === 'theme' ? '保存中…' : '保存'}</button>
            {themeDraft !== theme && <button type="button" className="button" disabled={saving !== ''} onClick={cancelTheme}>取消更改</button>}
          </div>
        </form>
      </Group>

      <Group index={1} active={tab}>
        <form ref={ratingFormRef} className="setting-item" aria-labelledby="rating-heading" onSubmit={event => { event.preventDefault(); void saveRating(); }}>
          <div>
            <h3 id="rating-heading">年龄分级</h3>
            <p>决定首页、搜索结果、收藏和详情中可见的内容。保存后会重新加载这些内容。</p>
          </div>
          <fieldset disabled={saving === 'rating'}>
            <legend className="visually-hidden">选择年龄分级</legend>
            {RATING_OPTIONS.map(option => <label key={option.value} className="rating-option">
              <input type="radio" name="rating" value={option.value} checked={draft === option.value} onChange={() => { setDraft(option.value); resetFeedback('rating'); }} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>)}
          </fieldset>
          {feedback('rating')}
          <div className="setting-actions">
            <button type="submit" className="button primary" disabled={saving !== '' || draft === rating}>{saving === 'rating' ? '保存中…' : '保存'}</button>
            {draft !== rating && <button type="button" className="button" disabled={saving !== ''} onClick={cancelRating}>取消更改</button>}
          </div>
        </form>

        <form className="setting-item" aria-labelledby="tags-heading" onSubmit={event => { event.preventDefault(); void saveTags(); }}>
          <div className="setting-row">
            <div>
              <h3 id="tags-heading">标签屏蔽</h3>
              <p>含有任一屏蔽标签的帖子不会出现在首页、搜索、收藏和详情中。会同时匹配标签中的词，例如屏蔽 blood 也会屏蔽 blood_on_face。</p>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label="启用标签屏蔽" checked={tagsDraft.blacklistEnabled} disabled={saving === 'tags'}
              onChange={event => { setTagsDraft({ ...tagsDraft, blacklistEnabled: event.target.checked }); resetFeedback('tags'); }} />
          </div>
          <fieldset disabled={saving === 'tags'} className="filter-editor" data-enabled={tagsDraft.blacklistEnabled}>
            <legend className="visually-hidden">屏蔽标签列表</legend>
            <div className="filter-input">
              <label htmlFor="filter-tag-input" className="visually-hidden">添加屏蔽标签</label>
              <input id="filter-tag-input" type="text" value={tagInput} placeholder="输入标签，多个用空格分隔" autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="done"
                onChange={event => setTagInput(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTags(); } }} />
              <button type="button" className="button" onClick={addTags} disabled={!tagInput.trim() || tagsDraft.blacklist.length >= TAG_FILTER_MAX}>添加</button>
            </div>
            {tagsDraft.blacklist.length ? <ul className="filter-tags">
              {tagsDraft.blacklist.map(tag => <li key={tag}>
                <span>{tag}</span>
                <button type="button" aria-label={`移除 ${tag}`} title="移除" onClick={() => { setTagsDraft({ ...tagsDraft, blacklist: tagsDraft.blacklist.filter(item => item !== tag) }); resetFeedback('tags'); }}><Icon name="close" /></button>
              </li>)}
            </ul> : <p className="filter-empty">尚未添加屏蔽标签。</p>}
          </fieldset>
          {feedback('tags')}
          <div className="setting-actions">
            <button type="submit" className="button primary" disabled={saving !== '' || !tagsDirty}>{saving === 'tags' ? '保存中…' : '保存'}</button>
            {tagsDirty && <button type="button" className="button" disabled={saving !== ''} onClick={() => { setTagsDraft(tagFilter); setTagInput(''); resetFeedback('tags'); }}>取消更改</button>}
          </div>
        </form>
      </Group>

      <Group index={2} active={tab}>
        <ProviderSettings />
        <ContextSettings />
        <MemorySettings />
      </Group>

      <Group index={3} active={tab}>
        {([
          ['history', '搜索历史', historyCount ? `已保存 ${historyCount} 条最近搜索` : '暂无搜索历史', historyCount === 0, '清空'],
          ['cache', '本地帖子缓存', cacheSize ? `约 ${Math.max(1, Math.round(cacheSize / 1024))} KB，用于加快列表打开速度` : '暂无缓存', cacheSize === 0, '清除'],
        ] as const).map(([key, title, desc, empty, action]) => <div key={key} className="setting-item">
          <div className="setting-row">
            <div>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
            <div className="setting-row-actions" aria-live="polite">
              {confirming === key && <button type="button" className="button" onClick={() => setConfirming(null)}>取消</button>}
              <button type="button" className={confirming === key ? 'button danger' : 'button'} disabled={empty && confirming !== key} onClick={() => clearData(key)}>
                {confirming === key ? `确认${action}` : action}
              </button>
            </div>
          </div>
          {feedback(key)}
        </div>)}
      </Group>

      <Group index={4} active={tab}>
        <div className="setting-item about">
          <div className="about-brand">
            <span className="brand-mark" aria-hidden="true">B</span>
            <div>
              <h3>BooruX</h3>
              <p>浏览、搜索与收藏 Danbooru 图片的轻量客户端。</p>
            </div>
          </div>
          <ul className="about-links">
            <li><a href="https://danbooru.donmai.us/" target="_blank" rel="noreferrer noopener"><span>数据来源</span><span>Danbooru<Icon name="open" /></span></a></li>
            <li><a href="https://github.com/djp440/BooruX" target="_blank" rel="noreferrer noopener"><span>源代码</span><span>GitHub<Icon name="open" /></span></a></li>
          </ul>
        </div>
      </Group>
    </>}
  </section>;
}
