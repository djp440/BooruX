import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchPosts, setPostBookmark, uniquePosts } from './feed';
import type { Post, PostsResponse } from './feed';
import { readPostCache, writePostCache } from './post-cache';

type BookmarkState = {
  snapshot: PostsResponse;
  ready: boolean;
  loading: boolean;
  error: string;
  pendingId: string | null;
  action: { id: string; message: string; error: boolean } | null;
  refresh: () => Promise<void>;
  toggle: (id: string, members: Post[]) => Promise<void>;
  clear: () => void;
};

const BookmarkContext = createContext<BookmarkState | null>(null);

export function BookmarkProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PostsResponse>(() =>
    readPostCache('favorites:default')?.data || { success: true, posts: [] });
  const snapshotRef = useRef(snapshot);
  const [ready, setReady] = useState(() => Boolean(readPostCache('favorites:default')));
  const [loading, setLoading] = useState(() => !readPostCache('favorites:default'));
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [action, setAction] = useState<BookmarkState['action']>(null);
  const request = useRef<Promise<void> | null>(null);
  const mutationPending = useRef(false);
  const revision = useRef(0);

  const replace = useCallback((data: PostsResponse) => {
    snapshotRef.current = data;
    setSnapshot(data);
    writePostCache('favorites:default', data);
  }, []);

  // 设置改变后丢弃可能属旧分级的收藏快照，并作废进行中的旧请求。
  const clear = useCallback(() => {
    revision.current++;
    request.current = null;
    replace({ success: true, posts: [] });
    setReady(false);
    setLoading(true);
  }, [replace]);

  const refresh = useCallback((): Promise<void> => {
    if (mutationPending.current) return Promise.resolve();
    if (request.current) return request.current;
    const started = revision.current;
    setLoading(true);
    setError('');
    request.current = fetchPosts('/api/profiles/default/bookmarks', new AbortController().signal, 'bookmarks')
      .then(data => {
        if (started !== revision.current) return;
        replace(data);
        setReady(true);
      })
      .catch(() => {
        if (started === revision.current) setError('收藏列表加载失败，请重试。');
      })
      .finally(() => {
        if (started === revision.current) {
          request.current = null;
          setLoading(false);
        }
      });
    return request.current;
  }, [replace]);

  const toggle = useCallback(async (id: string, members: Post[]) => {
    if (mutationPending.current || !members.length) return;
    const current = snapshotRef.current.posts;
    const memberIds = new Set(members.map(post => post.id));
    const saved = current.find(post => (post.parentId || post.id) === id || memberIds.has(post.id));
    const target = saved || members.find(post => post.id === id) || members[0];
    mutationPending.current = true;
    revision.current++;
    setPendingId(id);
    setAction(null);
    try {
      const post = await setPostBookmark(target.id, !saved);
      const latest = snapshotRef.current.posts;
      const posts = saved
        ? latest.filter(item => (item.parentId || item.id) !== (saved.parentId || saved.id) && !memberIds.has(item.id))
        : uniquePosts([post, ...latest]);
      replace({ success: true, posts });
      setReady(true);
      setError('');
      setAction({ id, message: saved ? '已取消收藏' : '收藏成功', error: false });
    } catch {
      setAction({ id, message: '收藏操作失败，请重试。', error: true });
    } finally {
      mutationPending.current = false;
      setPendingId(null);
    }
  }, [replace]);

  return (
    <BookmarkContext.Provider value={{ snapshot, ready, loading, error, pendingId, action, refresh, toggle, clear }}>
      {children}
    </BookmarkContext.Provider>
  );
}

export function useBookmarks() {
  const state = useContext(BookmarkContext);
  if (!state) throw new Error('收藏状态必须在 BookmarkProvider 内使用');
  return state;
}
