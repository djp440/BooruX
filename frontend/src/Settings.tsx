import { useEffect, useState } from 'react';
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetchSettings(controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setRating(value.rating);
        setDraft(value.rating);
        setTheme(value.themeMode);
        setThemeDraft(value.themeMode);
        applyTheme(value.themeMode);
      })
      .catch(value => {
        if (!controller.signal.aborted) setError(value instanceof Error ? value.message : '设置加载失败，请重试');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const saveRating = async () => {
    setSaving('rating');
    setError('');
    setNotice('');
    try {
      await saveSettings({ rating: draft });
      setRating(draft);
      // 年龄分级影响所有已加载内容：作废列表、搜索结果、详情和评论，并清理旧分级缓存。
      invalidate();
      clearBookmarks();
      clearPostsCache();
      setNotice('年龄分级已保存；返回首页或收藏时将按新分级重新加载。');
      setSaving('');
    } catch (value) {
      setError(value instanceof Error ? value.message : '年龄分级保存失败，请重试');
      setSaving('');
    }
  };

  const saveTheme = async () => {
    const previous = theme;
    setSaving('theme');
    setError('');
    setNotice('');
    applyTheme(themeDraft);
    try {
      await saveSettings({ themeMode: themeDraft });
      setTheme(themeDraft);
      setNotice('背景色已保存。');
    } catch (value) {
      applyTheme(previous);
      setThemeDraft(previous);
      setError(value instanceof Error ? value.message : '背景色保存失败，请重试');
    } finally {
      setSaving('');
    }
  };

  return <section className="settings" aria-label="设置">
    <h1>设置</h1>
    {error && <p className="setting-error" role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {notice && <p className="setting-notice" role="status">{notice}</p>}
    {loading ? <p role="status">正在加载设置…</p> : <>
      <form className="setting-item" aria-labelledby="theme-heading" onSubmit={event => { event.preventDefault(); void saveTheme(); }}>
        <div>
          <h2 id="theme-heading">背景色</h2>
          <p>选择界面外观；跟随系统会随设备设置自动切换。</p>
        </div>
        <fieldset disabled={saving === 'theme'}>
          <legend className="visually-hidden">选择背景色</legend>
          {THEME_OPTIONS.map(option => <label key={option.value} className="rating-option">
            <input type="radio" name="themeMode" value={option.value} checked={themeDraft === option.value} onChange={() => { setThemeDraft(option.value); applyTheme(option.value); setNotice(''); }} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
        </fieldset>
        <div className="setting-actions">
          <button type="submit" className="primary" disabled={saving !== '' || themeDraft === theme}>{saving === 'theme' ? '保存中…' : '保存'}</button>
          {themeDraft !== theme && <button type="button" disabled={saving !== ''} onClick={() => { setThemeDraft(theme); applyTheme(theme); setError(''); setNotice(''); }}>取消更改</button>}
        </div>
      </form>
      <form className="setting-item" aria-labelledby="rating-heading" onSubmit={event => { event.preventDefault(); void saveRating(); }}>
        <div>
          <h2 id="rating-heading">年龄分级</h2>
          <p>决定首页、搜索结果、收藏和详情中可见的内容。保存后会重新加载这些内容。</p>
        </div>
        <fieldset disabled={saving === 'rating'}>
          <legend className="visually-hidden">选择年龄分级</legend>
          {RATING_OPTIONS.map(option => <label key={option.value} className="rating-option">
            <input type="radio" name="rating" value={option.value} checked={draft === option.value} onChange={() => { setDraft(option.value); setNotice(''); }} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
        </fieldset>
        <div className="setting-actions">
          <button type="submit" className="primary" disabled={saving !== '' || draft === rating}>{saving === 'rating' ? '保存中…' : '保存'}</button>
          {draft !== rating && <button type="button" disabled={saving !== ''} onClick={() => { setDraft(rating); setError(''); setNotice(''); }}>取消更改</button>}
        </div>
      </form>
    </>}
  </section>;
}
