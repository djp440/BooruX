import { useEffect, useRef, useState } from 'react';
import { fetchPosts, originalMediaURL, postSource, uniquePosts } from './feed';
import type { Post } from './feed';
import { isFresh, readPostCache, writePostCache } from './post-cache';
import { useBookmarks } from './Bookmarks';

export function canOpenCard(
  target: unknown,
  currentTarget: { contains: (node: Node | null) => boolean },
  detail: number,
  pointerStart: { x: number; y: number } | null,
  currentPointer?: { x: number; y: number } | null,
  selection?: { isCollapsed?: boolean; toString: () => string; anchorNode: Node | null } | null,
  hasOpenHandler = true
): boolean {
  if (!hasOpenHandler) return false;
  if (!target || typeof (target as any).closest !== 'function') return false;
  const element = target as Element;
  if (element.closest('a, button, video, .post-media-track, .post-actions, .post-meta, .post-notice')) {
    return false;
  }
  if (
    selection &&
    !selection.isCollapsed &&
    selection.toString().length > 0 &&
    selection.anchorNode &&
    currentTarget.contains(selection.anchorNode)
  ) {
    return false;
  }
  if (detail > 0 && pointerStart && currentPointer) {
    const distance = Math.hypot(currentPointer.x - pointerStart.x, currentPointer.y - pointerStart.y);
    if (distance > 8) return false;
  }
  return true;
}

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
          <a href={src} target="_blank" rel="noreferrer noopener">打开原文件</a>
        </div>
      ) : post.mediaType === 'video' ? (
        <video src={src} controls playsInline preload="none" aria-label={label} onError={() => setFailed(true)} />
      ) : (
        <a className="media-original" href={src} target="_blank" rel="noreferrer noopener" aria-label={`打开原图：${label}`}>
          <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        </a>
      )}
    </figure>
  );
}

export default function PostCard({ id, posts: seed, trusted = false, onOpen, onComments }: { id: string; posts: Post[]; trusted?: boolean; onOpen?: () => void; onComments: () => void }) {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const bookmarks = useBookmarks();
  const bookmarked = bookmarks.snapshot.posts.some(post => (post.parentId || post.id) === id || seed.some(member => member.id === post.id));
  const busy = bookmarks.pendingId === id;
  const needsFamily = !trusted && id.startsWith('danbooru-') && seed.some(post => post.parentId || post.hasChildren || !originalMediaURL(post));
  const cacheKey = `family:default:${id}`;
  const [initialCache] = useState(() => trusted ? null : readPostCache(cacheKey));
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

  const posts = uniquePosts(trusted ? seed : [...seed, ...related]);
  posts.sort((a, b) => a.id === id ? -1 : b.id === id ? 1 : 0);
  const tags = [...new Map(posts.flatMap(post => post.tags || []).map(tag => [tag.name, tag])).values()];
  const source = postSource(posts[0].id);

  return (
    <article
      className="post-card"
      data-post-group={id}
      aria-label={`帖子 ${id}`}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={event => {
        if (!onOpen) return;
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen();
        }
      }}
      onPointerDown={event => {
        if (event.button === 0) {
          if (event.target instanceof Element && event.target.closest('a, button, video, .post-media-track, .post-actions, .post-meta')) return;
          pointer.current = { x: event.clientX, y: event.clientY };
        }
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onClick={event => {
        const start = pointer.current;
        pointer.current = null;
        const selection = typeof window !== 'undefined' ? window.getSelection() : null;
        if (
          canOpenCard(
            event.target,
            event.currentTarget,
            event.detail,
            start,
            { x: event.clientX, y: event.clientY },
            selection,
            Boolean(onOpen)
          )
        ) {
          onOpen?.();
        }
      }}
    >
      <header className="post-meta" onClick={event => event.stopPropagation()}>
        {source.href ? (
          <a href={source.href} target="_blank" rel="noreferrer noopener">{source.label}</a>
        ) : (
          <span>{source.label}</span>
        )}
        <span>{posts.length} 个媒体</span>
        {onOpen && <button className="detail-entry" onClick={onOpen}>查看详情</button>}
      </header>
      <div className="post-tags" tabIndex={0} aria-label="帖子标签">
        {tags.length ? tags.map(tag => <span className="post-tag" key={tag.name}>{tag.name}</span>) : <span>暂无标签</span>}
      </div>
      {needsFamily && status === 'loading' && !related.length && <p className="post-notice" role="status">正在加载关联媒体…</p>}
      {needsFamily && status === 'error' && (
        <p className="post-notice" role="alert">{related.length ? '关联媒体更新失败，正在显示已缓存内容。' : '关联媒体加载失败，当前展示不完整。'}<button onClick={() => setAttempt(value => value + 1)}>重试</button></p>
      )}
      {cached && <p className="post-notice">仅显示本地缓存，关联媒体可能不完整。</p>}
      <div
        className="post-media-track"
        tabIndex={posts.length > 1 ? 0 : -1}
        role="region"
        aria-label={posts.length > 1 ? `帖子媒体，共 ${posts.length} 项，可横向滚动` : '帖子媒体'}
      >
        {posts.map(post => <Media key={`${post.id}:${originalMediaURL(post)}`} post={post} />)}
      </div>
      <footer className="post-actions" onClick={event => event.stopPropagation()}>
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
        <button onClick={onComments} aria-label="查看评论">
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
