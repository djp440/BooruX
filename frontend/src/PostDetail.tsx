import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import PostCard from './PostCard';
import { postSource } from './feed';
import { commentKey, commentTextParts, commentsComplete, commentsNeedReload, createComments, fetchCommentPage, loadComments } from './comments';
import type { PostDetailData } from './comments';
import { beginRestore, capturePosition, restorePosition, usePageSession } from './page-session';
import { useBookmarks } from './Bookmarks';
import { readPostDetailCache, removePostCache, writePostCache } from './post-cache';

export default function PostDetail() {
  const { id = '' } = useParams();
  const { page, back } = usePageSession();
  const { refresh } = useBookmarks();
  const cacheKey = `detail:default:${id}`;
  const [detail, setDetail] = useState<PostDetailData | null>(() => {
    page.detail ||= readPostDetailCache(cacheKey) || undefined;
    return page.detail || null;
  });
  const [comments, setComments] = useState(() => {
    if (detail) page.comments ||= createComments(detail.posts);
    return page.comments;
  });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(!!detail);
  const commentsRegion = useRef<HTMLElement>(null);
  const initialLoad = useRef(false);
  const request = useRef<AbortController | null>(null);
  const focusComments = () => {
    commentsRegion.current?.scrollIntoView({ block: 'start' });
    commentsRegion.current?.focus({ preventScroll: true });
    page.position = capturePosition();
  };

  useEffect(() => {
    const controller = new AbortController();
    setError(''); setBusy(false);
    void refresh();
    fetch(`/api/posts/${encodeURIComponent(id)}/detail?profileId=default`, { signal: controller.signal })
      .then(async response => {
        const data: PostDetailData = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok || !data.success || !Array.isArray(data.posts)) {
          if ([401, 403, 404].includes(response.status)) {
            removePostCache(cacheKey);
            page.detail = undefined; page.comments = undefined; initialLoad.current = false;
            request.current?.abort(); request.current = null;
            setDetail(null); setComments(undefined); setVerified(false); setBusy(false);
          }
          throw new Error(data.error || '帖子详情加载失败，请重试');
        }
        const previous = page.detail?.posts.map(post => post.id).sort().join(',');
        const members = data.posts.map(post => post.id).sort().join(',');
        if (previous !== members || data.commentsAvailability !== 'available') {
          request.current?.abort(); request.current = null; setBusy(false);
          page.comments = createComments(data.posts); initialLoad.current = false;
        }
        page.detail = data;
        writePostCache(cacheKey, data);
        page.comments ||= createComments(data.posts);
        setComments(page.comments); setDetail(data); setVerified(true);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : '帖子详情加载失败，请重试');
      });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [id, page, attempt, refresh, cacheKey]);

  useLayoutEffect(() => {
    if (!verified) return;
    if (page.commentsIntent) {
      focusComments();
      // 定位意图仅消费一次，不影响主导航恢复该会话的位置。
      page.commentsIntent = false;
      return;
    }
    return beginRestore(page.position);
  }, [verified, page]);

  const load = async (retry = false) => {
    if (request.current || !page.comments || !verified || !detail) return;
    const reload = retry && commentsNeedReload(page.comments);
    const controller = new AbortController(); request.current = controller; setBusy(true);
    const position = capturePosition();
    const firstVisible = [...document.querySelectorAll<HTMLElement>('[data-comment-key]')].find(node => node.getBoundingClientRect().bottom > 70);
    const anchor = firstVisible ? { key: firstVisible.dataset.commentKey, offset: firstVisible.getBoundingClientRect().top } : null;
    if (reload) { page.comments = createComments(detail.posts); setComments(page.comments); }
    try {
      const updated = await loadComments(page.comments, (member, cursor) => fetchCommentPage(id, member, cursor, controller.signal), retry);
      if (controller.signal.aborted) return;
      page.comments = updated; setComments(updated);
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        if (Math.abs(window.scrollY - position.y) > 2) return;
        const target = anchor && [...document.querySelectorAll<HTMLElement>('[data-comment-key]')].find(node => node.dataset.commentKey === anchor.key);
        if (target && anchor) window.scrollBy(0, target.getBoundingClientRect().top - anchor.offset);
        else restorePosition(position);
        page.position = capturePosition();
      });
    } finally {
      if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  };

  useEffect(() => {
    if (verified && detail?.commentsAvailability === 'available' && !initialLoad.current) {
      initialLoad.current = true;
      if (!page.comments?.displayed.length && !page.comments?.streams.some(stream => stream.error) && !commentsComplete(page.comments!)) void load();
    }
  }, [verified, detail]);

  return <section className="post-detail feed" aria-label="帖子详情">
    <header className="detail-header"><button onClick={back} aria-label="返回列表">← 返回</button><h1>帖子详情</h1></header>
    {!verified && !error && <p role="status">正在加载帖子详情…</p>}
    {error && <div role="alert"><p>{detail ? '详情更新失败，正在显示缓存内容。' : error}</p><button onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
    {verified && detail && <>
      <PostCard id={detail.groupId} posts={detail.posts} trusted onComments={focusComments} />
      {!detail.familyComplete && <p className="post-notice">仅显示本地关联帖子，帖子组可能不完整。</p>}
      <section className="comments" ref={commentsRegion} tabIndex={-1} aria-label="原站评论">
        <h2>原站评论</h2>
        <p className="comment-note">整组评论按时间最新优先，仅供阅读。</p>
        {detail.commentsAvailability === 'local-only' ? <p role="status">仅本地数据模式，原站评论不可用。</p> : detail.commentsAvailability === 'unsupported' ? <p role="status">此来源暂不支持原站评论。</p> : comments && <>
          {comments.displayed.map(comment => <article className="comment" key={commentKey(comment)} data-comment-key={commentKey(comment)}>
            <header><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('zh-CN')}</time></header>
            <a href={comment.sourceUrl} target="_blank" rel="noreferrer noopener">{postSource(comment.postId).label} · 原站评论 #{comment.id}</a>
            <p className="comment-body">{commentTextParts(comment.body).map((part, index) => part.href ? <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a> : part.text)}</p>
          </article>)}
          <div className="comment-status" aria-live="polite">
            {comments.streams.filter(stream => stream.error).map(stream => <p role="alert" key={stream.memberId}>{postSource(stream.memberId).label} 的评论暂缺：{stream.error}</p>)}
            {comments.streams.some(stream => stream.error) && <button disabled={busy} onClick={() => void load(true)}>{commentsNeedReload(comments) ? '重新加载评论' : '重试缺失评论'}</button>}
            {busy && <p role="status">正在加载原站评论…</p>}
            {!busy && !comments.displayed.length && commentsComplete(comments) && <p>暂无评论。</p>}
            {!busy && comments.displayed.length > 0 && detail.familyComplete && commentsComplete(comments) && <p>已加载全部评论</p>}
            {!busy && !commentsComplete(comments) && comments.streams.some(stream => !stream.error && (!stream.exhausted || stream.buffer.length > 0)) && <button onClick={() => void load()}>加载更多评论</button>}
          </div>
        </>}
      </section>
    </>}
  </section>;
}
