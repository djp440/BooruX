import { useEffect, useState } from 'react';
import { fetchPosts, groupPosts, uniquePosts } from './feed';
import type { PostsResponse } from './feed';
import { isFresh, readPostCache, writePostCache } from './post-cache';
import { useBookmarks } from './Bookmarks';
import PostCard from './PostCard';
import { usePageSession, beginRestore } from './page-session';
import { clearSearchHistory, normalizeTagQuery, readSearchHistory, saveSearchHistory, searchCacheKey, SEARCH_MAX_LENGTH } from './search';

export default function PostFeed({ kind }: { kind: 'home' | 'favorites' }) {
  const { page } = usePageSession();
  const [query, setQuery] = useState(page.feedQuery || '');
  const [draft, setDraft] = useState(query);
  const [history, setHistory] = useState(readSearchHistory);
  const search = (value: string) => {
    const next = normalizeTagQuery(value);
    setDraft(next);
    if (next) setHistory(current => saveSearchHistory(current, next));
    if (next === query) return;
    page.feedQuery = next;
    page.feed = undefined;
    page.position = { y: 0, anchors: [] };
    setQuery(next);
    window.scrollTo(0, 0);
  };
  return <section className="feed" aria-label={kind === 'home' ? 'Danbooru 帖子列表' : '收藏帖子列表'}>
    {kind === 'home' && <div className="tag-search">
      <form role="search" aria-label="搜索帖子标签" onSubmit={event => { event.preventDefault(); search(draft); }}>
        <label htmlFor="tag-search">搜索标签</label>
        <div className="search-controls">
          <input id="tag-search" type="search" value={draft} maxLength={SEARCH_MAX_LENGTH} autoComplete="off" autoCapitalize="none" autoCorrect="off" enterKeyHint="search" spellCheck={false}
            placeholder="例如：sky blue_hair" aria-describedby="tag-search-help" onChange={event => setDraft(event.target.value)} />
          <button type="submit" className="search-submit">搜索</button>
        </div>
        <p id="tag-search-help">多个 tag 用空格分隔，同时匹配；tag 内的空格用下划线。</p>
      </form>
      {history.length > 0 && <div className="search-history" aria-label="搜索历史">
        <div className="search-history-heading"><span>搜索历史</span><button type="button" onClick={() => { clearSearchHistory(); setHistory([]); }}>清空历史</button></div>
        <ul>{history.map(item => <li key={item}><button type="button" onClick={() => search(item)}>{item}</button></li>)}</ul>
      </div>}
      {query && <div className="search-current"><span>搜索结果：{query}</span><button type="button" onClick={() => search('')}>显示全部</button></div>}
    </div>}
    <FeedResults key={`${kind}:${query}`} kind={kind} query={query} onReset={() => search('')} />
  </section>;
}

export function FeedResults({ kind, query, onReset }: { kind: 'home' | 'favorites'; query: string; onReset?: () => void }) {
  const { page, open } = usePageSession();
  const bookmarks = useBookmarks();
  const { refresh: refreshBookmarks } = bookmarks;
  const cacheKey = searchCacheKey(query);
  const [initialCache] = useState(() => readPostCache(cacheKey));
  const [restoredFeed] = useState(page.feed);
  const [feed, setFeed] = useState<PostsResponse>(page.feed || initialCache?.data || { success: true, posts: [], nextCursor: '' });
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(!page.feed && !initialCache);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

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
        setFeed(current => {
          const updated: PostsResponse = {
            ...data,
            posts: uniquePosts(cursor ? [...current.posts, ...data.posts] : data.posts),
          };
          page.feed = updated;
          writePostCache(cacheKey, updated);
          return updated;
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('帖子加载失败，请检查网络或服务后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, attempt, initialCache, kind, cacheKey, query]);

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
  return (
    <div className="feed-results">
      {displayed.source === 'sqlite' && <p className="feed-notice" role="status">当前展示本地缓存。</p>}
      {kind === 'home' && bookmarks.error && <p className="feed-notice" role="alert">收藏状态加载失败。<button onClick={() => void refreshBookmarks()}>重试</button></p>}
      {groups.map(group => <PostCard key={group.id} id={group.id} posts={group.posts} onOpen={() => open(group.posts.find(post => post.id === group.id)?.id || group.posts[0].id)} onComments={() => open(group.posts.find(post => post.id === group.id)?.id || group.posts[0].id, true)} />)}
      <div className="feed-status" aria-live="polite">
        {bookmarks.action && !bookmarks.action.error && <p role="status">{bookmarks.action.message}</p>}
        {displayedLoading && <p role="status">{groups.length ? '正在更新帖子…' : '正在加载帖子…'}</p>}
        {displayedError && <><p role="alert">{groups.length ? '帖子更新失败，正在显示已缓存内容。' : displayedError}</p><button onClick={retry}>重试</button></>}
        {!displayedLoading && !displayedError && !groups.length && (kind === 'home' && query ? (
          <><p>没有匹配这些标签的帖子，请修改标签或显示全部。</p>{onReset && <button type="button" onClick={onReset}>显示全部</button>}</>
        ) : (
          <p>{kind === 'home' ? '暂无可展示的 Danbooru 帖子。' : '暂无收藏的帖子。'}</p>
        ))}
        {!displayedError && nextCursor && <button disabled={displayedLoading} aria-busy={displayedLoading} onClick={() => setCursor(nextCursor)}>加载更多</button>}
        {!displayedLoading && !displayedError && groups.length > 0 && !nextCursor && <p>已加载全部帖子</p>}
      </div>
    </div>
  );
}
