import { useEffect, useState } from 'react';
import { fetchPosts, groupPosts, originalMediaURL, postSource, uniquePosts } from './feed';
import type { Post, PostsResponse } from './feed';
import { isFresh, readPostCache, writePostCache } from './post-cache';
import { useBookmarks } from './Bookmarks';

function Media({ post }: { post: Post }) {
  const [failed, setFailed] = useState(false);
  const src = originalMediaURL(post);
  const { label } = postSource(post.id);
  return (
    <figure className="post-media">
      {!src ? (
        <p className="media-message">未提供可访问的原始媒体</p>
      ) : failed ? (
        <div className="media-message" role="status">
          <p>媒体加载失败</p>
          <button onClick={() => setFailed(false)}>重试</button>
          <a href={src} target="_blank" rel="noreferrer">打开原文件</a>
        </div>
      ) : post.mediaType === 'video' ? (
        <video src={src} controls playsInline preload="none" aria-label={label} onError={() => setFailed(true)} />
      ) : (
        <a className="media-original" href={src} target="_blank" rel="noreferrer" aria-label={`打开原图：${label}`}>
          <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        </a>
      )}
    </figure>
  );
}

function PostCard({ id, posts: seed }: { id: string; posts: Post[] }) {
  const bookmarks = useBookmarks();
  const bookmarked = bookmarks.snapshot.posts.some(post => (post.parentId || post.id) === id);
  const busy = bookmarks.pendingId === id;
  const needsFamily = id.startsWith('danbooru-') && seed.some(post => post.parentId || post.hasChildren || !originalMediaURL(post));
  const cacheKey = `family:default:${id}`;
  const [initialCache] = useState(() => readPostCache(cacheKey));
  const [related, setRelated] = useState<Post[]>(initialCache?.data.posts || []);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(initialCache ? 'ready' : 'loading');
  const [cached, setCached] = useState(initialCache?.data.source === 'sqlite');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needsFamily || (attempt === 0 && initialCache && isFresh(initialCache))) return;
    const controller = new AbortController();
    setStatus('loading');
    fetchPosts(`/api/danbooru/posts/${encodeURIComponent(id)}/family?profileId=default`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setRelated(data.posts);
        writePostCache(cacheKey, data);
        setCached(data.source === 'sqlite');
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [id, needsFamily, attempt, initialCache, cacheKey]);

  const posts = uniquePosts([...seed, ...related]);
  posts.sort((a, b) => a.id === id ? -1 : b.id === id ? 1 : 0);
  const tags = [...new Map(posts.flatMap(post => post.tags || []).map(tag => [tag.name, tag])).values()];
  const source = postSource(posts[0].id);

  return (
    <article className="post-card" aria-label={`帖子 ${id}`}>
      <header className="post-meta">
        <a href={source.href} target="_blank" rel="noreferrer">{source.label}</a>
        <span>{posts.length} 个媒体</span>
      </header>
      <div className="post-tags" tabIndex={0} aria-label="帖子标签">
        {tags.length ? tags.map(tag => <span className="post-tag" key={tag.name}>{tag.name}</span>) : <span>暂无标签</span>}
      </div>
      {needsFamily && status === 'loading' && !related.length && <p className="post-notice" role="status">正在加载关联媒体…</p>}
      {needsFamily && status === 'error' && (
        <p className="post-notice" role="alert">{related.length ? '关联媒体更新失败，正在显示已缓存内容。' : '关联媒体加载失败，当前展示不完整。'}<button onClick={() => setAttempt(value => value + 1)}>重试</button></p>
      )}
      {cached && <p className="post-notice">仅显示本地缓存，关联媒体可能不完整。</p>}
      <div className="post-media-track" tabIndex={0} role="region" aria-label={`帖子媒体，共 ${posts.length} 项，可横向滚动`}>
        {posts.map(post => <Media key={`${post.id}:${originalMediaURL(post)}`} post={post} />)}
      </div>
      <footer className="post-actions">
        <button
          className="bookmark-button"
          aria-label={bookmarked ? '取消收藏' : '收藏'}
          aria-pressed={bookmarked}
          aria-busy={busy}
          disabled={!bookmarks.ready || bookmarks.pendingId !== null}
          onClick={() => void bookmarks.toggle(id, posts)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z" /></svg>
          <span>{busy ? '处理中…' : bookmarked ? '已收藏' : '收藏'}</span>
        </button>
        <button disabled title="评论功能尚未开放">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" /></svg>
          <span>评论</span>
        </button>
        <button disabled title="转发功能尚未开放">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" /></svg>
          <span>转发</span>
        </button>
      </footer>
      {bookmarks.action?.id === id && bookmarks.action.error && <p className="post-notice" role="alert">{bookmarks.action.message}</p>}
    </article>
  );
}

export default function PostFeed({ kind }: { kind: 'home' | 'favorites' }) {
  const bookmarks = useBookmarks();
  const { refresh: refreshBookmarks } = bookmarks;
  const cacheKey = 'feed:default';
  const [initialCache] = useState(() => readPostCache(cacheKey));
  const [feed, setFeed] = useState<PostsResponse>(initialCache?.data || { success: true, posts: [], nextCursor: '' });
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { void refreshBookmarks(); }, [refreshBookmarks]);

  useEffect(() => {
    if (kind !== 'home' || (!cursor && attempt === 0 && initialCache && isFresh(initialCache))) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ profileId: 'default', limit: '10', cursor });
    fetchPosts(`/api/danbooru/posts?${params}`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        const updated: PostsResponse = {
          ...data,
          posts: uniquePosts(cursor ? [...feed.posts, ...data.posts] : data.posts),
        };
        setFeed(updated);
        writePostCache(cacheKey, updated);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('帖子加载失败，请检查网络或服务后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, attempt, initialCache, kind, cacheKey]);

  const displayed = kind === 'home' ? feed : bookmarks.snapshot;
  const displayedLoading = kind === 'home' ? loading : bookmarks.loading;
  const displayedError = kind === 'home' ? error : bookmarks.error;
  const retry = kind === 'home' ? () => setAttempt(value => value + 1) : () => void refreshBookmarks();
  const groups = groupPosts(kind === 'home' ? displayed.posts.filter(post => post.id.startsWith('danbooru-')) : displayed.posts);
  const nextCursor = displayed.nextCursor || '';
  return (
    <section className="feed" aria-label={kind === 'home' ? 'Danbooru 帖子列表' : '收藏帖子列表'}>
      {displayed.source === 'sqlite' && <p className="feed-notice" role="status">当前展示本地缓存。</p>}
      {kind === 'home' && bookmarks.error && <p className="feed-notice" role="alert">收藏状态加载失败。<button onClick={() => void refreshBookmarks()}>重试</button></p>}
      {groups.map(group => <PostCard key={group.id} id={group.id} posts={group.posts} />)}
      <div className="feed-status" aria-live="polite">
        {bookmarks.action && !bookmarks.action.error && <p role="status">{bookmarks.action.message}</p>}
        {displayedLoading && <p role="status">{groups.length ? '正在更新帖子…' : '正在加载帖子…'}</p>}
        {displayedError && <><p role="alert">{groups.length ? '帖子更新失败，正在显示已缓存内容。' : displayedError}</p><button onClick={retry}>重试</button></>}
        {!displayedLoading && !displayedError && !groups.length && <p>{kind === 'home' ? '暂无可展示的 Danbooru 帖子。' : '暂无收藏的帖子。'}</p>}
        {!displayedLoading && !displayedError && nextCursor && <button onClick={() => setCursor(nextCursor)}>加载更多</button>}
        {!displayedLoading && !displayedError && groups.length > 0 && !nextCursor && <p>已加载全部帖子</p>}
      </div>
    </section>
  );
}
