import type { Post, PostsResponse } from './feed';

export type Comment = {
  id: string;
  postId: string;
  source: string;
  author: string;
  createdAt: string;
  body: string;
  sourceUrl: string;
};
export type CommentPage = {
  success: boolean;
  availability: string;
  memberId: string;
  comments: Comment[];
  nextCursor: string | null;
  exhausted: boolean;
};
export type CommentStream = {
  memberId: string;
  buffer: Comment[];
  nextCursor: string | null;
  exhausted: boolean;
  error: string;
  reloadRequired: boolean;
  seen: Set<string>;
};
export type CommentsState = { streams: CommentStream[]; displayed: Comment[] };
export type PostDetailData = PostsResponse & {
  groupId: string;
  familyComplete: boolean;
  commentsAvailability: 'available' | 'local-only' | 'unsupported';
};

export const commentKey = (comment: Comment) => JSON.stringify([comment.source, comment.postId, comment.id]);
export function compareComments(a: Comment, b: Comment): number {
  for (const [left, right] of [[b.createdAt, a.createdAt], [a.source, b.source], [a.postId, b.postId], [a.id, b.id]]) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
export function createComments(posts: Post[]): CommentsState {
  return { displayed: [], streams: posts.map(post => ({ memberId: post.id, buffer: [], nextCursor: null, exhausted: false, error: '', reloadRequired: false, seen: new Set() })) };
}
export const commentsComplete = (state: CommentsState) => state.streams.every(stream => stream.exhausted && !stream.buffer.length && !stream.error);

export const commentsNeedReload = (state: CommentsState) => state.streams.some(stream => stream.reloadRequired);

export class CommentPageError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CommentPageError';
  }
}

export async function fetchCommentPage(id: string, memberId: string, cursor: string | null, signal: AbortSignal): Promise<CommentPage> {
  const query = new URLSearchParams({ profileId: 'default', memberId, limit: '25' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/posts/${encodeURIComponent(id)}/comments?${query}`, { signal });
  let raw: any;
  try {
    raw = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    const statusMsg = response.status ? ` (HTTP ${response.status})` : '';
    throw new CommentPageError(`服务响应异常${statusMsg}，请稍后重试`, response.status);
  }
  const page = raw;
  if (!response.ok || !page?.success || page?.availability !== 'available' || page?.memberId !== memberId || !Array.isArray(page?.comments)) {
    throw new CommentPageError(page?.error || '评论暂时无法加载，请重试', response.status);
  }
  return page;
}

// 每次选择之前补齐健康流的头部，跨成员和跨页均保持时间降序。
export async function loadComments(
  current: CommentsState,
  request: (member: string, cursor: string | null) => Promise<CommentPage>,
  retry = false,
  count = 25,
): Promise<CommentsState> {
  const state: CommentsState = {
    displayed: [...current.displayed],
    streams: current.streams.map(stream => ({
      ...stream,
      buffer: [...stream.buffer],
      seen: new Set(stream.seen),
      error: retry ? '' : stream.error,
      reloadRequired: retry ? false : stream.reloadRequired,
    })),
  };
  const shown = new Set(state.displayed.map(commentKey));
  let emitted = 0;
  let requests = 0;
  while (emitted < count) {
    const empty = state.streams.filter(stream => !stream.exhausted && !stream.error && !stream.buffer.length);
    for (let start = 0; start < empty.length; start += 3) {
      await Promise.all(empty.slice(start, start + 3).map(async stream => {
        try {
          if (++requests > 160) throw new Error('本次查询达到限制，评论尚未完整加载，请重试');
          const page = await request(stream.memberId, stream.nextCursor);
          if (!page.exhausted && (!page.nextCursor || page.nextCursor === stream.nextCursor)) throw new Error('评论分页未前进，请重试');
          if (page.comments.some(comment => comment.postId !== stream.memberId || !Number.isFinite(Date.parse(comment.createdAt)))) throw new Error('评论数据无效，请重试');
          const unique = page.comments.map(comment => ({
            ...comment,
            author: comment.author?.trim() || '匿名用户',
          })).filter(comment => {
            const key = commentKey(comment);
            if (stream.seen.has(key)) return false;
            stream.seen.add(key);
            return true;
          });
          stream.buffer.push(...unique.sort(compareComments));
          stream.exhausted = page.exhausted;
          stream.nextCursor = page.nextCursor;
        } catch (error) {
          stream.reloadRequired = error instanceof CommentPageError && error.status === 409;
          stream.error = error instanceof Error ? error.message : '评论暂时无法加载，请重试';
        }
      }));
    }
    if (state.streams.some(stream => !stream.error && !stream.exhausted && !stream.buffer.length)) continue;
    const candidates = state.streams.filter(stream => stream.buffer.length);
    candidates.sort((a, b) => compareComments(a.buffer[0], b.buffer[0]));
    if (!candidates.length) break;
    const comment = candidates[0].buffer.shift()!;
    if (!shown.has(commentKey(comment))) {
      shown.add(commentKey(comment));
      state.displayed.push(comment);
      emitted++;
    }
  }
  state.displayed.sort(compareComments);
  return state;
}

export function commentTextParts(body: string): { text: string; href?: string }[] {
  return body.split(/(https?:\/\/[^\s<>"']+)/gi).filter(Boolean).map(text => {
    try {
      const url = new URL(text);
      if (url.protocol === 'https:' || url.protocol === 'http:') return { text, href: url.href };
    } catch { /* 普通文本由 React 转义。 */ }
    return { text };
  });
}
