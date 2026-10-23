import { useEffect, useRef, useState } from 'react';
import { RATING_OPTIONS, THEME_OPTIONS, applyTheme, fetchSettings, saveSettings } from './rating-settings';
import type { Rating, Theme } from './rating-settings';
import { usePageSession } from './page-session';
import { useBookmarks } from './Bookmarks';
import { clearPostsCache } from './post-cache';

export default function Settings() {
  const { invalidate } = usePageSession();
  const { clear: clearBookmarks } = useBookmarks();
  const [rating, setRating] = useState<Rating>('general');
  const [draft, setDraft] = useState<Rating>('general');
  const [theme, setTheme] = useState<Theme>('system');
  const [themeDraft, setThemeDraft] = useState<Theme>('system');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [retrySave, setRetrySave] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

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

  const saveRating = async () => {
    setSaving('rating');
    setSaveError('');
    setNotice('');
    try {
      await saveSettings({ rating: draft });
      setRating(draft);
      // 年龄分级影响所有已加载内容：作废列表、搜索结果、详情和评论，并清理旧分级缓存。
      invalidate();
      clearBookmarks();
      clearPostsCache();
      setNotice('年龄分级已保存；返回首页或收藏时将按新分级重新加载。');
      setRetrySave(null);
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
    setSaveError('');
    setNotice('');
    try {
      await saveSettings({ themeMode: themeDraft });
      setTheme(themeDraft);
      savedThemeRef.current = themeDraft;
      applyTheme(themeDraft, true);
      setNotice('背景色已保存。');
      setRetrySave(null);
    } catch (value) {
      applyTheme(previous, false);
      setThemeDraft(previous);
      setSaveError(value instanceof Error ? value.message : '背景色保存失败，请重试');
      setRetrySave(() => () => void saveTheme());
    } finally {
      setSaving('');
    }
  };

  const cancelTheme = () => {
    setThemeDraft(theme);
    applyTheme(theme, false);
    setSaveError('');
    setRetrySave(null);
    setNotice('');
    const target = themeFormRef.current?.querySelector<HTMLInputElement>(`input[value="${theme}"]`);
    target?.focus();
  };

  const cancelRating = () => {
    setDraft(rating);
    setSaveError('');
    setRetrySave(null);
    setNotice('');
    const target = ratingFormRef.current?.querySelector<HTMLInputElement>(`input[value="${rating}"]`);
    target?.focus();
  };

  return <section className="settings" aria-label="设置">
    <header className="page-header"><h1>设置</h1></header>
    {loadError && <p className="setting-error" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {saveError && <p className="setting-error" role="alert">{saveError}{retrySave && <button type="button" className="text-button" onClick={retrySave}>重试</button>}</p>}
    {notice && <p className="setting-notice" role="status">{notice}</p>}
    {loading ? <div className="setting-loading" role="status"><span className="spinner" aria-hidden="true" />正在加载设置…</div> : <>
      <form ref={themeFormRef} className="setting-item" aria-labelledby="theme-heading" onSubmit={event => { event.preventDefault(); void saveTheme(); }}>
        <div>
          <h2 id="theme-heading">背景色</h2>
          <p>选择界面外观；跟随系统会随设备设置自动切换。</p>
        </div>
        <fieldset className="theme-options" disabled={saving === 'theme'}>
          <legend className="visually-hidden">选择背景色</legend>
          {THEME_OPTIONS.map(option => <label key={option.value} className="rating-option theme-option">
            <span className="theme-swatch" data-preview={option.value} aria-hidden="true" />
            <input type="radio" name="themeMode" value={option.value} checked={themeDraft === option.value} onChange={() => { setThemeDraft(option.value); applyTheme(option.value, false); setNotice(''); setSaveError(''); setRetrySave(null); }} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
        </fieldset>
        <div className="setting-actions">
          <button type="submit" className="button primary" disabled={saving !== '' || themeDraft === theme}>{saving === 'theme' ? '保存中…' : '保存'}</button>
          {themeDraft !== theme && <button type="button" className="button" disabled={saving !== ''} onClick={cancelTheme}>取消更改</button>}
        </div>
      </form>
      <form ref={ratingFormRef} className="setting-item" aria-labelledby="rating-heading" onSubmit={event => { event.preventDefault(); void saveRating(); }}>
        <div>
          <h2 id="rating-heading">年龄分级</h2>
          <p>决定首页、搜索结果、收藏和详情中可见的内容。保存后会重新加载这些内容。</p>
        </div>
        <fieldset disabled={saving === 'rating'}>
          <legend className="visually-hidden">选择年龄分级</legend>
          {RATING_OPTIONS.map(option => <label key={option.value} className="rating-option">
            <input type="radio" name="rating" value={option.value} checked={draft === option.value} onChange={() => { setDraft(option.value); setNotice(''); setSaveError(''); setRetrySave(null); }} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
        </fieldset>
        <div className="setting-actions">
          <button type="submit" className="button primary" disabled={saving !== '' || draft === rating}>{saving === 'rating' ? '保存中…' : '保存'}</button>
          {draft !== rating && <button type="button" className="button" disabled={saving !== ''} onClick={cancelRating}>取消更改</button>}
        </div>
      </form>
    </>}
  </section>;
}
