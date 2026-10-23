import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { fetchPosts, originalMediaURL, postSource, relativeTime, uniquePosts } from './feed';
import type { Post } from './feed';
import { isFresh, readPostCache, writePostCache } from './post-cache';
import { useBookmarks } from './Bookmarks';
import { Icon } from './icons';
import MediaViewer from './MediaViewer';

// 普通左键点击才拦截为应用内行为；中键与修饰键保留链接的新标签页打开。
const isPlainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

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

// 翻到相邻媒体：按钮只服务鼠标用户（触屏横滑、键盘聚焦轨道后方向键滚动），因此不进入 Tab 序列。
function scrollToSibling(button: HTMLElement, direction: -1 | 1) {
  const figure = button.closest('.post-media');
  const target = direction < 0 ? figure?.previousElementSibling : figure?.nextElementSibling;
  target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function Media({ post, index, count, onView }: { post: Post; index: number; count: number; onView: (index: number) => void }) {
  const src = originalMediaURL(post);
  const video = post.mediaType === 'video';
  // 图片加载前显示占位微光，加载后淡入；视频不预加载，直接显示原生控件。
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(video ? 'ready' : 'loading');
  const { label } = postSource(post.id);
  return (
    <figure className="post-media" data-state={src ? state : 'failed'}>
      {count > 1 && <>
        <span className="post-media-count" aria-hidden="true">{index + 1} / {count}</span>
        {index > 0 && <button type="button" tabIndex={-1} className="media-nav prev" aria-label="上一项媒体" title="上一项" onClick={event => scrollToSibling(event.currentTarget, -1)}><Icon name="prev" /></button>}
        {index < count - 1 && <button type="button" tabIndex={-1} className="media-nav next" aria-label="下一项媒体" title="下一项" onClick={event => scrollToSibling(event.currentTarget, 1)}><Icon name="next" /></button>}
      </>}
      {!src ? (
        <p className="media-message"><Icon name="image" />未提供可访问的原始媒体</p>
      ) : state === 'failed' ? (
        <div className="media-message" role="status">
          <Icon name="image" />
          <p>媒体加载失败</p>
          <div className="media-message-actions">
            <button className="button" onClick={() => setState(video ? 'ready' : 'loading')}>重试</button>
            <a href={src} target="_blank" rel="noreferrer noopener">打开原文件</a>
          </div>
        </div>
      ) : video ? (
        <video src={src} controls playsInline preload="none" aria-label={label} onError={() => setState('failed')} />
      ) : (
        <a className="media-original" href={src} target="_blank" rel="noreferrer noopener" aria-label={`查看大图：${label}`} onClick={event => { if (isPlainClick(event)) { event.preventDefault(); onView(index); } }}>
          <img src={src} alt={label} loading="lazy" decoding="async" ref={img => { if (img?.complete && img.naturalWidth) setState('ready'); }} onLoad={() => setState('ready')} onError={() => setState('failed')} />
        </a>
      )}
    </figure>
  );
}

export default function PostCard({ id, posts: seed, trusted = false, onOpen, onComments, onAuthor }: { id: string; posts: Post[]; trusted?: boolean; onOpen?: () => void; onComments: () => void; onAuthor?: (artist: string) => void }) {
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
  const [viewing, setViewing] = useState<number | null>(null);

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
  const primary = posts[0];
  const artist = typeof primary.artist === 'string' ? primary.artist.trim() : '';
  const author = artist && !/^unknown(?:[ _]artist)?$/i.test(artist) ? artist.replaceAll('_', ' ') : '未知作者';
  // 作者即 Danbooru 画师标签，只有已知的 Danbooru 作者才能进入作者页。
  const artistHref = onAuthor && author !== '未知作者' && primary.id.startsWith('danbooru-') ? `/artists/${encodeURIComponent(artist)}` : '';
  const openAuthor = (event: MouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    onAuthor?.(artist);
  };
  const initial = author === '未知作者' ? '?' : Array.from(author)[0];
  const title = typeof primary.title === 'string' ? primary.title.trim() : '';
  const createdAt = typeof primary.createdAt === 'string' && primary.createdAt ? new Date(primary.createdAt) : null;
  const date = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : null;
  const aspectRatio = primary.aspectRatio && Number.isFinite(primary.aspectRatio) && primary.aspectRatio > 0 ? primary.aspectRatio : undefined;

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
      {artistHref
        ? <a className="post-avatar" href={artistHref} tabIndex={-1} aria-hidden="true" onClick={openAuthor}>{initial}</a>
        : <div className="post-avatar" aria-hidden="true">{initial}</div>}
      <div className="post-content">
        <header className="post-meta" onClick={event => event.stopPropagation()}>
          <div className="post-meta-primary">
            {artistHref
              ? <a className="post-author" href={artistHref} title="查看作者主页" onClick={openAuthor}>{author}</a>
              : <strong className="post-author">{author}</strong>}
            {source.href ? (
              <a className="post-source" href={source.href} target="_blank" rel="noreferrer noopener">{source.label}</a>
            ) : (
              <span className="post-source">{source.label}</span>
            )}
            {date && <span className="post-meta-time"><span className="post-meta-separator" aria-hidden="true">·</span><time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')}>{relativeTime(date)}</time></span>}
          </div>
          {onOpen && <button className="detail-entry" onClick={onOpen} aria-label="查看详情" title="查看详情"><Icon name="open" /></button>}
        </header>
        {title && <p className="post-body">{title}</p>}
        <div className="post-tags" data-preview={Boolean(onOpen)} role="region" aria-label="帖子标签" title={onOpen ? '进入详情查看完整标签' : undefined}>
          {tags.length ? tags.map(tag => <span className="post-tag" key={tag.name}>{`#${tag.name} `}</span>) : <span>暂无标签</span>}
        </div>
        {needsFamily && status === 'loading' && !related.length && <p className="post-notice" role="status"><span className="spinner" aria-hidden="true" />正在加载关联媒体…</p>}
        {needsFamily && status === 'error' && (
          <p className="post-notice" role="alert">{related.length ? '关联媒体更新失败，正在显示已缓存内容。' : '关联媒体加载失败，当前展示不完整。'}<button className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>
        )}
        {cached && <p className="post-notice">仅显示本地缓存，关联媒体可能不完整。</p>}
        <div
          className="post-media-track"
          style={{ aspectRatio }}
          tabIndex={posts.length > 1 ? 0 : -1}
          role="region"
          aria-label={posts.length > 1 ? `帖子媒体，共 ${posts.length} 项，可横向滚动` : '帖子媒体'}
        >
          {posts.map((post, index) => <Media key={`${post.id}:${originalMediaURL(post)}`} post={post} index={index} count={posts.length} onView={setViewing} />)}
        </div>
        <footer className="post-actions" onClick={event => event.stopPropagation()}>
          <button className="comment-button" onClick={onComments} aria-label="查看评论" title="查看评论">
            <Icon name="comment" />
            <span className="visually-hidden">评论</span>
          </button>
          <button disabled aria-label="转发功能尚未开放" title="转发功能尚未开放">
            <Icon name="repost" />
            <span className="visually-hidden">转发</span>
          </button>
          <button
            className="bookmark-button"
            aria-label={bookmarked ? '取消收藏' : '收藏'}
            aria-pressed={bookmarked}
            aria-busy={busy}
            title={busy ? '处理中…' : bookmarked ? '取消收藏' : '收藏'}
            disabled={!bookmarks.ready || bookmarks.pendingId !== null}
            onClick={() => void bookmarks.toggle(id, posts)}
          >
            <Icon name="bookmark" />
            <span className="visually-hidden">{busy ? '处理中…' : bookmarked ? '已收藏' : '收藏'}</span>
          </button>
        </footer>
        {viewing !== null && <MediaViewer posts={posts} start={viewing} onClose={() => setViewing(null)} />}
        {bookmarks.action?.id === id && bookmarks.action.error && <p className="post-notice" role="alert">{bookmarks.action.message}</p>}
      </div>
    </article>
  );
}
