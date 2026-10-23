import { useEffect, useRef, useState } from 'react';
import { fetchPosts, groupPosts, uniquePosts } from './feed';
import type { PostsResponse } from './feed';
import { isFresh, readPostCache, writePostCache } from './post-cache';
import { useBookmarks } from './Bookmarks';
import PostCard from './PostCard';
import { usePageSession, beginRestore } from './page-session';
import { clearSearchHistory, normalizeTagQuery, readSearchHistory, saveSearchHistory, searchCacheKey, SEARCH_MAX_LENGTH } from './search';
import { Icon } from './icons';

export function SkeletonCard() {
  return <div className="skeleton-card" aria-hidden="true">
    <span className="skeleton-avatar" />
    <span className="skeleton-lines"><i /><i /><i /><b /></span>
  </div>;
}

export default function PostFeed({ kind }: { kind: 'home' | 'favorites' }) {
  const { page } = usePageSession();
  const [query, setQuery] = useState(page.feedQuery || '');
  const [draft, setDraft] = useState(query);
  const [history, setHistory] = useState(readSearchHistory);
  const search = (value: string) => {
    const next = normalizeTagQuery(value);
    setDraft(next);
    if (next) {
      const updatedHistory = saveSearchHistory(history, next);
      setHistory(updatedHistory);
    }
    if (next === query) return;
    page.feedQuery = next;
    page.feed = undefined;
    page.position = { y: 0, anchors: [] };
    setQuery(next);
    window.scrollTo(0, 0);
  };
  return <section className="feed" aria-label={kind === 'home' ? 'Danbooru 帖子列表' : '收藏帖子列表'}>
    {kind === 'home' ? <>
      <header className="page-header search-header">
        <h1 className="visually-hidden">首页</h1>
        <form role="search" aria-label="搜索帖子标签" onSubmit={event => { event.preventDefault(); search(draft); }}>
          <label htmlFor="tag-search" className="visually-hidden">搜索标签</label>
          <div className="search-controls">
            <span className="search-field">
              <Icon name="search" />
              <input id="tag-search" type="search" value={draft} maxLength={SEARCH_MAX_LENGTH} autoComplete="off" autoCapitalize="none" autoCorrect="off" enterKeyHint="search" spellCheck={false}
                placeholder="搜索标签" aria-describedby="tag-search-help" onChange={event => setDraft(event.target.value)} />
            </span>
            <button type="submit" className="button primary search-submit">搜索</button>
          </div>
        </form>
      </header>
      <div className="tag-search">
        <p id="tag-search-help" className="search-help">多个 tag 用空格分隔并同时匹配，tag 内的空格用下划线，例如 sky blue_hair。</p>
        {query && <div className="search-current"><span>正在显示 <strong>{query}</strong> 的结果</span><button type="button" className="text-button" onClick={() => search('')}>显示全部</button></div>}
        {history.length > 0 && <div className="search-history" aria-label="搜索历史">
          <div className="search-history-heading"><span><Icon name="history" />最近搜索</span><button type="button" onClick={() => { clearSearchHistory(); setHistory([]); }}>清空历史</button></div>
          <ul>{history.map(item => <li key={item}><button type="button" className={item === query ? 'active' : undefined} onClick={() => search(item)}>{item}</button></li>)}</ul>
        </div>}
      </div>
    </> : <header className="page-header"><h1>收藏</h1></header>}
    <FeedResults key={`${kind}:${query}`} kind={kind} query={query} onReset={() => search('')} />
  </section>;
}

export function FeedResults({ kind, query, onReset }: { kind: 'home' | 'favorites'; query: string; onReset?: () => void }) {
  const { page, open, goArea } = usePageSession();
  const bookmarks = useBookmarks();
  const { refresh: refreshBookmarks } = bookmarks;
  const cacheKey = searchCacheKey(query);
  const [initialCache] = useState(() => readPostCache(cacheKey));
  const [restoredFeed] = useState(page.feed);
  const [feed, setFeed] = useState<PostsResponse>(page.feed || initialCache?.data || { success: true, posts: [], nextCursor: '' });
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(!page.feed && !initialCache);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => { void refreshBookmarks(); }, [refreshBookmarks]);

  useEffect(() => {
    if (kind !== 'home' || (!cursor && attempt === 0 && restoredFeed) || (!cursor && attempt === 0 && initialCache && isFresh(initialCache))) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ profileId: 'default', limit: '10', cursor, tags: query });
    fetchPosts(`/api/danbooru/posts?${params}`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        const currentPosts = cursor ? feedRef.current.posts : [];
        const updated: PostsResponse = {
          ...data,
          posts: uniquePosts(cursor ? [...currentPosts, ...data.posts] : data.posts),
        };
        page.feed = updated;
        writePostCache(cacheKey, updated);
        setFeed(updated);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('帖子加载失败，请检查网络或服务后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, attempt, initialCache, kind, cacheKey, query, page]);

  useEffect(() => { if (kind === 'home' && initialCache && !page.feed) page.feed = initialCache.data; }, [initialCache, kind, page]);

  useEffect(() => {
    if (kind !== 'favorites') return;
    return beginRestore(page.position);
  }, [bookmarks.snapshot, kind, page]);

  const displayed = kind === 'home' ? feed : bookmarks.snapshot;
  const displayedLoading = kind === 'home' ? loading : bookmarks.loading;
  const displayedError = kind === 'home' ? error : bookmarks.error;
  const retry = kind === 'home' ? () => setAttempt(value => value + 1) : () => void refreshBookmarks();
  const groups = groupPosts(kind === 'home' ? displayed.posts.filter(post => post.id.startsWith('danbooru-')) : displayed.posts);
  const nextCursor = displayed.nextCursor || '';

  // 接近列表底部时自动加载下一页；按钮保留为键盘与失败后的手动入口。每次状态变化重建观察器，
  // 以便新页加载后按钮仍在预取范围内时继续加载。
  useEffect(() => {
    const button = more.current;
    if (kind !== 'home' || !button || displayedLoading || displayedError || !nextCursor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setCursor(nextCursor);
    }, { rootMargin: '0px 0px 800px' });
    observer.observe(button);
    return () => observer.disconnect();
  }, [kind, displayedLoading, displayedError, nextCursor]);

  return (
    <div className="feed-results">
      {displayed.source === 'sqlite' && <p className="feed-notice" role="status">当前展示本地缓存。</p>}
      {kind === 'home' && bookmarks.error && <p className="feed-notice" role="alert">收藏状态加载失败。<button className="text-button" onClick={() => void refreshBookmarks()}>重试</button></p>}
      {groups.map(group => <PostCard key={group.id} id={group.id} posts={group.posts} onOpen={() => open(group.posts.find(post => post.id === group.id)?.id || group.posts[0].id)} onComments={() => open(group.posts.find(post => post.id === group.id)?.id || group.posts[0].id, true)} />)}
      {displayedLoading && !groups.length && <><SkeletonCard /><SkeletonCard /><SkeletonCard /></>}
      <div className="feed-status" aria-live="polite">
        {displayedLoading && <p role="status" className="visually-hidden">{groups.length ? '正在更新帖子…' : '正在加载帖子…'}</p>}
        {displayedError && (groups.length ? (
          <div className="inline-alert" role="alert"><Icon name="alert" /><p>帖子更新失败，正在显示已缓存内容。</p><button className="button" onClick={retry}>重试</button></div>
        ) : (
          <div className="empty-state" role="alert">
            <span className="empty-icon"><Icon name="alert" /></span>
            <p className="empty-title">{displayedError}</p>
            <button className="button primary" onClick={retry}>重试</button>
          </div>
        ))}
        {!displayedLoading && !displayedError && !groups.length && (kind === 'home' && query ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="search" /></span>
            <p>没有匹配这些标签的帖子，请修改标签或显示全部。</p>{onReset && <button type="button" onClick={onReset}>显示全部</button>}
          </div>
        ) : kind === 'favorites' ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="bookmark" /></span>
            <p className="empty-title">暂无收藏的帖子。</p>
            <p className="empty-desc">在首页浏览帖子时，点击卡片底部的收藏按钮即可将喜欢的作品保存在这里。</p>
            <button type="button" className="button primary" onClick={() => goArea('home')}>去首页浏览</button>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="image" /></span>
            <p className="empty-title">暂无可展示的 Danbooru 帖子。</p>
          </div>
        ))}
        {!displayedError && nextCursor && <button ref={more} className="button load-more" disabled={displayedLoading} aria-busy={displayedLoading} onClick={() => setCursor(nextCursor)}>
          {displayedLoading ? <><span className="spinner" aria-hidden="true" />正在加载…</> : '加载更多'}
        </button>}
        {!displayedLoading && !displayedError && groups.length > 0 && !nextCursor && <p className="feed-end">已加载全部帖子</p>}
      </div>
    </div>
  );
}
