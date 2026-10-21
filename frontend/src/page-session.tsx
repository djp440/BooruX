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
}

export function capturePosition(): Position {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-post-group]')];
  const index = cards.findIndex(card => card.getBoundingClientRect().bottom > 0);
  const anchors = index < 0 ? [] : [cards[index], cards[index + 1], cards[index - 1]].filter(Boolean).map(card => ({ id: card.dataset.postGroup!, offset: card.getBoundingClientRect().top }));
  return { y: window.scrollY, anchors };
}
export function positionTarget(position: Position, cards: { id: string; top: number }[], max: number): number {
  for (const anchor of position.anchors) {
    const card = cards.find(card => card.id === anchor.id);
    if (card) return Math.max(0, Math.min(max, card.top - anchor.offset));
  }
  return Math.max(0, Math.min(max, position.y));
}
export function restorePosition(position: Position) {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-post-group]')].map(card => ({ id: card.dataset.postGroup!, top: card.getBoundingClientRect().top + window.scrollY }));
  window.scrollTo(0, positionTarget(position, cards, Math.max(0, document.documentElement.scrollHeight - window.innerHeight)));
}

// 异步布局仅在短恢复窗口内校正；用户输入后立即交还滚动控制。
export function beginRestore(position: Position): () => void {
  let stopped = false;
  let frame = 0;
  const started = performance.now();
  const stop = () => { stopped = true; cancelAnimationFrame(frame); };
  const tick = () => {
    if (stopped) return;
    restorePosition(position);
    if (performance.now() - started < 1000) frame = requestAnimationFrame(tick);
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, stop, { once: true, passive: true });
  frame = requestAnimationFrame(tick);
  return () => { stop(); for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, stop); };
}

const SessionContext = createContext<{ store: PageSessions; page: PageSession; save: () => void; open: (id: string, comments?: boolean) => void; back: () => void; goArea: (area: Area) => void; invalidate: () => void } | null>(null);
export function PageSessionProvider({ children }: { children: ReactNode }) {
  const store = useRef(new PageSessions()).current;
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const page = store.visit(location.key, location.pathname, type, location.state?.sessionId);
  const save = () => { page.position = capturePosition(); };
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
    const record = () => { if (!restoring && (!isDetail || document.querySelector('.post-detail .post-card'))) page.position = capturePosition(); };
    const release = () => { restoring = false; };
    window.addEventListener('scroll', record, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, release, { passive: true });
    return () => {
      cancel(); window.clearTimeout(timer); window.removeEventListener('scroll', record);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(event, release);
    };
  }, [page, location.key]);
  return <SessionContext.Provider value={{ store, page, save,
    open: (id, comments = false) => {
      save();
      const path = `${listPath(areaForPath(location.pathname)).replace(/\/$/, '')}/posts/${encodeURIComponent(id)}`;
      const detail = store.open(path, page, location.key);
      detail.commentsIntent = comments;
      navigate(path, { state: { sessionId: detail.id } });
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
      const last = store.lastVisit[area];
      navigate(last?.path || listPath(area), { state: last ? { sessionId: last.id } : null });
    },
    invalidate: () => store.invalidateContent(),
  }}>{children}</SessionContext.Provider>;
}
export function usePageSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('缺少页面会话');
  return value;
}
