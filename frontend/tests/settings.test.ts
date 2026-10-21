import { describe, expect, test } from 'bun:test';
import { RATING_OPTIONS, THEME_OPTIONS, THEME_STORAGE_KEY, applyTheme, isRating, isTheme, readCachedTheme } from '../src/rating-settings';
import { PageSessions } from '../src/page-session';
import { clearPostsCache, readPostCache, writePostCache } from '../src/post-cache';

function storage() {
  let raw: string | null = null;
  return { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
}

describe('设置页背景色', () => {
  function fakeDocument() {
    const attributes = new Map<string, string>();
    const values = new Map<string, string>();
    const root = {
      dataset: {
        get theme() { return attributes.get('data-theme'); },
        set theme(value: string) { attributes.set('data-theme', value); },
      },
      removeAttribute: (name: string) => { attributes.delete(name); },
    };
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    return { root, storage, attributes };
  }
  test('三档背景色可供选择，未知值回退为跟随系统', () => {
    expect(THEME_OPTIONS.map(option => option.value)).toEqual(['light', 'dark', 'system']);
    for (const value of ['light', 'dark', 'system']) expect(isTheme(value)).toBe(true);
    for (const value of ['', 'auto', 'DARK', null, 0]) expect(isTheme(value)).toBe(false);
  });
  test('浅色和暗色写入根标记，跟随系统移除标记交由媒体查询', () => {
    const { root, storage } = fakeDocument();
    const originalDocument = globalThis.document;
    const originalStorage = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
      applyTheme('dark');
      expect(globalThis.document.documentElement.dataset.theme).toBe('dark');
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      applyTheme('system');
      expect(globalThis.document.documentElement.dataset.theme).toBeUndefined();
      expect(readCachedTheme()).toBe('system');
      applyTheme('light');
      expect(globalThis.document.documentElement.dataset.theme).toBe('light');
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    }
  });
  test('缓存损坏或存储不可用时按跟随系统处理', () => {
    const { storage } = fakeDocument();
    const originalStorage = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
      storage.setItem(THEME_STORAGE_KEY, 'sepia');
      expect(readCachedTheme()).toBe('system');
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } } });
      expect(readCachedTheme()).toBe('system');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    }
  });
  test('五档分级可供选择，未知值回退而不误设', () => {
    expect(RATING_OPTIONS.map(option => option.value)).toEqual(['general', 'sensitive', 'questionable', 'explicit', 'all']);
    for (const value of ['general', 'sensitive', 'questionable', 'explicit', 'all']) expect(isRating(value)).toBe(true);
    for (const value of ['', 'safe', null, 1, undefined]) expect(isRating(value)).toBe(false);
  });
  test('保存分级后清空所有列表、搜索和详情会话，避免旧内容残留', () => {
    const store = new PageSessions();
    const home = store.visit('h1', '/', 'POP');
    home.feed = { success: true, posts: [], nextCursor: 'd:9' };
    home.feedQuery = 'sky blue_hair';
    home.position = { y: 800, anchors: [{ id: 'danbooru-1', offset: -10 }] };
    const detail = store.open('/posts/danbooru-1', home, 'h1');
    store.visit('h2', detail.path, 'PUSH', detail.id);
    detail.detail = { success: true, groupId: 'danbooru-1', posts: [], source: 'danbooru', familyComplete: true, commentsAvailability: 'available' };
    detail.comments = { streams: [], displayed: [] };
    const favorites = store.visit('f1', '/favorites', 'PUSH');
    favorites.feed = { success: true, posts: [], nextCursor: '' };
    store.lastVisit.home = detail;
    store.invalidateContent();
    expect(store.lastVisit).toEqual({});
    expect(home.feed).toBeUndefined();
    expect(home.feedQuery).toBeUndefined();
    expect(home.position).toEqual({ y: 0, anchors: [] });
    expect(detail.detail).toBeUndefined();
    expect(detail.comments).toBeUndefined();
    expect(favorites.feed).toBeUndefined();
    expect(store.pages.size).toBe(3);
  });
  test('清空持久缓存后，未保存的搜索列表不会跨分级复用；存储不可用可降级', () => {
    const store = storage();
    const data = { success: true, posts: [], nextCursor: 'd:1' };
    writePostCache('feed:default', data, store);
    writePostCache('feed:default:tags:sky', data, store);
    clearPostsCache(store);
    expect(readPostCache('feed:default', store)).toBeNull();
    expect(readPostCache('feed:default:tags:sky', store)).toBeNull();
    const unavailable = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } };
    expect(() => clearPostsCache(unavailable)).not.toThrow();
  });
});
