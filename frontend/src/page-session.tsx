import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import type { PostsResponse } from './feed';
import type { CommentsState, PostDetailData } from './comments';

export type Area = 'home' | 'favorites';
export const areaForPath = (path: string): Area => path === '/favorites' || path.startsWith('/favorites/') ? 'favorites' : 'home';
export const listPath = (area: Area) => area === 'home' ? '/' : '/favorites';
export type Position = { y: number; anchors: { id: string; offset: number }[] };
export type PageSession = {
  id: string;
  path: string;
  position: Position;
  origin?: { key: string; sessionId: string; path: string };
  commentsIntent?: boolean;
  feed?: PostsResponse;
  feedQuery?: string;
  detail?: PostDetailData;
  comments?: CommentsState;
};

export class PageSessions {
  pages = new Map<string, PageSession>();
  entries: { key: string; sessionId: string }[] = [];
  index = -1;
  lastVisit: Partial<Record<Area, PageSession>> = {};
  sequence = 0;

  visit(key: string, path: string, type: string, sessionId?: string): PageSession {
    const known = this.entries.findIndex(entry => entry.key === key);
    if (known >= 0) this.index = known;
    else {
      const entry = { key, sessionId: sessionId && this.pages.has(sessionId) ? sessionId : key };
      if (type === 'REPLACE' && this.index >= 0) this.entries[this.index] = entry;
      else { this.entries.splice(this.index + 1); this.entries.push(entry); this.index = this.entries.length - 1; }
    }
    const id = this.entries[this.index].sessionId;
    let page = this.pages.get(id);
    if (!page) { page = { id, path, position: { y: 0, anchors: [] } }; this.pages.set(id, page); }
    if (path === '/' || path.startsWith('/posts/') || path === '/favorites' || path.startsWith('/favorites/posts/')) this.lastVisit[areaForPath(path)] = page;
    this.prune();
    return page;
  }

  open(path: string, from: PageSession, key: string): PageSession {
    const page: PageSession = { id: `detail-${++this.sequence}`, path, position: { y: 0, anchors: [] }, origin: { key, sessionId: from.id, path: from.path } };
    this.pages.set(page.id, page);
    return page;
  }
  backDelta(page: PageSession): number | null {
    if (!page.origin) return null;
    const index = this.entries.findIndex(entry => entry.key === page.origin!.key);
    return index >= 0 && index !== this.index ? index - this.index : null;
  }
  // 影响可见内容的设置保存后，丢弃所有已加载列表/详情，避免旧分级继续展示。
  invalidateContent(): void {
    this.lastVisit = {};
    for (const page of this.pages.values()) {
      page.feed = undefined;
      page.feedQuery = undefined;
      page.detail = undefined;
      page.comments = undefined;
      page.position = { y: 0, anchors: [] };
    }
  }

  // 回收历史分支截断后不在 entries、不在 lastVisit 且未被活跃 origin 引用的孤立详情会话。
  prune(): void {
    const reachable = new Set<string>();
    for (const entry of this.entries) {
      if (entry.sessionId) reachable.add(entry.sessionId);
    }
    for (const session of Object.values(this.lastVisit)) {
      if (session?.id) reachable.add(session.id);
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const id of Array.from(reachable)) {
        const page = this.pages.get(id);
        if (page?.origin?.sessionId && !reachable.has(page.origin.sessionId)) {
          reachable.add(page.origin.sessionId);
          expanded = true;
        }
      }
    }
    for (const id of Array.from(this.pages.keys())) {
      if (!reachable.has(id)) {
        this.pages.delete(id);
      }
    }
  }
}

export function capturePosition(): Position {
  if (typeof window !== 'undefined' && window.scrollY === 0) {
    return { y: 0, anchors: [] };
  }
  const cards = typeof document !== 'undefined' ? [...document.querySelectorAll<HTMLElement>('[data-post-group]')] : [];
  const index = cards.findIndex(card => card.getBoundingClientRect().bottom > 0);
  const anchors = index < 0 ? [] : [cards[index], cards[index + 1], cards[index - 1]].filter(Boolean).map(card => ({ id: card.dataset.postGroup!, offset: card.getBoundingClientRect().top }));
  return { y: typeof window !== 'undefined' ? window.scrollY : 0, anchors };
}
export function positionTarget(position: Position, cards: { id: string; top: number }[], max: number): number {
  for (const anchor of position.anchors) {
    const card = cards.find(card => card.id === anchor.id);
    if (card) return Math.max(0, Math.min(max, card.top - anchor.offset));
  }
  return Math.max(0, Math.min(max, position.y));
}
export function restorePosition(position: Position) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  if (!position.anchors || position.anchors.length === 0) {
    const target = Math.max(0, Math.min(max, position.y));
    if (Math.abs(window.scrollY - target) > 0.5) window.scrollTo(0, target);
    return;
  }
  const cards: { id: string; top: number }[] = [];
  const targetAnchors = position.anchors.slice(0, 3);
  for (const anchor of targetAnchors) {
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(anchor.id) : anchor.id.replace(/["\\]/g, '\\$&');
    const el = document.querySelector<HTMLElement>(`[data-post-group="${escaped}"]`);
    if (el) {
      cards.push({ id: anchor.id, top: el.getBoundingClientRect().top + window.scrollY });
    }
  }
  const target = positionTarget(position, cards, max);
  if (Math.abs(window.scrollY - target) > 0.5) window.scrollTo(0, target);
}

// 异步布局在短恢复窗口内校正；比对连续帧间位移，一旦检测到用户拖拽原生滚动条等外部位移立即打断交还控制权。
export function beginRestore(position: Position): () => void {
  if (typeof window === 'undefined') return () => {};
  let stopped = false;
  let frame = 0;
  let lastY = -1;
  const started = performance.now();
  const stop = () => { stopped = true; cancelAnimationFrame(frame); };
  const tick = () => {
    if (stopped) return;
    if (lastY >= 0 && Math.abs(window.scrollY - lastY) > 1) {
      stop();
      return;
    }
    restorePosition(position);
    lastY = window.scrollY;
    if (performance.now() - started < 1000) frame = requestAnimationFrame(tick);
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, stop, { once: true, passive: true });
  frame = requestAnimationFrame(tick);
  return () => {
    stop();
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, stop);
  };
}

export function createThrottledScrollHandler(
  onFrame: () => void,
  shouldSkip?: () => boolean,
): { handleScroll: () => void; cancel: () => void } {
  let ticking = false;
  let rafId = 0;
  return {
    handleScroll: () => {
      if (shouldSkip?.()) return;
      if (!ticking) {
        ticking = true;
        rafId = requestAnimationFrame(() => {
          ticking = false;
          if (!shouldSkip?.()) {
            onFrame();
          }
        });
      }
    },
    cancel: () => {
      ticking = false;
      cancelAnimationFrame(rafId);
    },
  };
}

export function handleAreaNav(
  area: Area,
  currentPath: string,
  page: PageSession,
  store: PageSessions,
  navigate: (path: string, options?: any) => void,
  smoothScroll: (options: ScrollToOptions) => void = opts => window.scrollTo(opts),
): 'scroll_to_top' | 'navigated' {
  const currentArea = areaForPath(currentPath);
  const isCurrentList = currentPath === listPath(area);
  if (currentArea === area && isCurrentList) {
    page.position = { y: 0, anchors: [] };
    if (store.lastVisit[area]) store.lastVisit[area]!.position = { y: 0, anchors: [] };
    smoothScroll({ top: 0, behavior: 'smooth' });
    return 'scroll_to_top';
  }
  const last = store.lastVisit[area];
  navigate(last?.path || listPath(area), { state: last ? { sessionId: last.id } : null });
  return 'navigated';
}

const SessionContext = createContext<{
  store: PageSessions;
  page: PageSession;
  save: () => void;
  open: (id: string, comments?: boolean) => void;
  openArtist: (artist: string) => void;
  back: () => void;
  goArea: (area: Area) => void;
  invalidate: () => void;
} | null>(null);

export function PageSessionProvider({ children }: { children: ReactNode }) {
  const store = useRef(new PageSessions()).current;
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const page = store.visit(location.key, location.pathname, type, location.state?.sessionId);
  const save = () => { page.position = capturePosition(); };
  const scrollingToTopRef = useRef(false);

  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);

  useLayoutEffect(() => {
    let restoring = true;
    const isDetail = location.pathname.includes('/posts/');
    const cancel = isDetail ? () => {} : beginRestore(page.position);
    const timer = window.setTimeout(() => { restoring = false; }, 1100);

    const { handleScroll, cancel: cancelScrollThrottle } = createThrottledScrollHandler(
      () => {
        if (!restoring && !scrollingToTopRef.current && (!isDetail || document.querySelector('.post-detail .post-card'))) {
          page.position = capturePosition();
        }
      },
      () => {
        if (restoring || scrollingToTopRef.current) {
          if (window.scrollY === 0) scrollingToTopRef.current = false;
          return true;
        }
        return false;
      },
    );

    const release = () => {
      restoring = false;
      scrollingToTopRef.current = false;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, release, { passive: true });
    return () => {
      cancel();
      cancelScrollThrottle();
      window.clearTimeout(timer);
      window.removeEventListener('scroll', handleScroll);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(event, release);
    };
  }, [page, location.key]);

  return <SessionContext.Provider value={{
    store,
    page,
    save,
    open: (id, comments = false) => {
      save();
      const path = `${listPath(areaForPath(location.pathname)).replace(/\/$/, '')}/posts/${encodeURIComponent(id)}`;
      const detail = store.open(path, page, location.key);
      detail.commentsIntent = comments;
      navigate(path, { state: { sessionId: detail.id } });
    },
    // 作者页与详情一样记录来源，返回按钮可退回原列表并恢复位置。
    openArtist: artist => {
      save();
      const path = `/artists/${encodeURIComponent(artist)}`;
      const target = store.open(path, page, location.key);
      navigate(path, { state: { sessionId: target.id } });
    },
    back: () => {
      save();
      const delta = store.backDelta(page);
      if (delta !== null) navigate(delta);
      else if (page.origin) navigate(page.origin.path, { state: { sessionId: page.origin.sessionId } });
      else navigate(listPath(areaForPath(location.pathname)));
    },
    goArea: area => {
      save();
      const res = handleAreaNav(area, location.pathname, page, store, (path, opts) => navigate(path, opts));
      if (res === 'scroll_to_top') {
        scrollingToTopRef.current = true;
      }
    },
    invalidate: () => store.invalidateContent(),
  }}>{children}</SessionContext.Provider>;
}

export function usePageSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('缺少页面会话');
  return value;
}
