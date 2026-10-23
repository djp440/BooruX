import type { Post, PostsResponse } from './feed';
import type { PostDetailData } from './comments';

const STORAGE_KEY = 'boorux:post-cache:v1';
const MAX_AGE = 24 * 60 * 60 * 1000;
const FRESH_AGE = 5 * 60 * 1000;
const MAX_ENTRIES = 40;
const MAX_SIZE = 2 * 1024 * 1024;

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
export type CachedPosts = { savedAt: number; data: PostsResponse };

function validPosts(value: unknown): value is Post[] {
  return Array.isArray(value) && value.every(post => post &&
    typeof post.id === 'string' && typeof post.imageUrl === 'string' &&
    (post.parentId == null || typeof post.parentId === 'string') &&
    (post.originalUrl == null || typeof post.originalUrl === 'string') &&
    (post.tags == null || (Array.isArray(post.tags) && post.tags.every((tag: Post['tags'][number]) =>
      tag && typeof tag.name === 'string'))));
}

export function isFresh(entry: CachedPosts): boolean {
  return Date.now() - entry.savedAt < FRESH_AGE;
}

export function readPostCache(key: string, storage?: StorageAccess): CachedPosts | null {
  try {
    const entries = JSON.parse((storage ?? localStorage).getItem(STORAGE_KEY) || '{}');
    const entry = entries?.[key];
    const age = Date.now() - entry?.savedAt;
    if (typeof entry?.savedAt !== 'number' || !Number.isFinite(age) || age < 0 || age > MAX_AGE ||
      entry.data?.success !== true || !validPosts(entry.data.posts) ||
      (entry.data.nextCursor != null && typeof entry.data.nextCursor !== 'string')) return null;
    return entry;
  } catch {
    return null;
  }
}

export function readPostDetailCache(key: string, storage?: StorageAccess): PostDetailData | null {
  const data = readPostCache(key, storage)?.data;
  if (!data || !('groupId' in data) || typeof data.groupId !== 'string' || !data.posts.some(post => post.id === data.groupId) ||
    !('familyComplete' in data) || typeof data.familyComplete !== 'boolean' || !('commentsAvailability' in data) ||
    (data.commentsAvailability !== 'available' && data.commentsAvailability !== 'local-only' && data.commentsAvailability !== 'unsupported')) return null;
  return { ...data, groupId: data.groupId, familyComplete: data.familyComplete, commentsAvailability: data.commentsAvailability };
}

export function removePostCache(key: string, storage?: StorageAccess): void {
  try {
    const target = storage ?? localStorage;
    const raw = target.getItem(STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !(key in entries)) return;
    delete entries[key];
    target.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 与读取、写入一致，存储不可用时不阻断页面。
  }
}

// 缓存占用的字符数（近似字节数），供设置页展示；存储不可用时为 0。
export function postsCacheSize(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const value = (storage ?? localStorage).getItem(STORAGE_KEY);
    return value && value !== '{}' ? value.length : 0;
  } catch {
    return 0;
  }
}

export function clearPostsCache(storage?: StorageAccess): void {
  try {
    (storage ?? localStorage).setItem(STORAGE_KEY, '{}');
  } catch {
    // 存储不可用时仅保留当前页面内存，不阻断设置保存。
  }
}

export function writePostCache(key: string, data: PostsResponse, storage?: StorageAccess): void {
  try {
    const target = storage ?? localStorage;
    let entries: Record<string, CachedPosts> = {};
    try {
      const parsed = JSON.parse(target.getItem(STORAGE_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed;
    } catch {
      // 损坏的缓存可直接由本次成功响应替换。
    }
    const now = Date.now();
    entries[key] = { savedAt: now, data };
    const olderKeys = Object.keys(entries).filter(item => item !== key)
      .sort((a, b) => (entries[a]?.savedAt || 0) - (entries[b]?.savedAt || 0));
    for (const item of olderKeys) {
      if (!entries[item]?.savedAt || now - entries[item].savedAt > MAX_AGE) delete entries[item];
    }
    const remainingOlderKeys = olderKeys.filter(item => item in entries);
    let count = Object.keys(entries).length;
    for (const item of remainingOlderKeys) {
      if (count <= MAX_ENTRIES) break;
      delete entries[item];
      count--;
    }
    let serialized = JSON.stringify(entries);
    if (serialized.length * 2 > MAX_SIZE) {
      const candidates = remainingOlderKeys.filter(item => item in entries);
      for (const item of candidates) {
        delete entries[item];
        serialized = JSON.stringify(entries);
        if (serialized.length * 2 <= MAX_SIZE) break;
      }
    }
    // shortcut: 单条结果超过 2 MiB 时仅留在页面内存，需大量离线帖子时改用 IndexedDB。
    if (serialized.length * 2 <= MAX_SIZE) target.setItem(STORAGE_KEY, serialized);
  } catch {
    // 存储被禁用或配额不足时，帖子仍可正常浏览。
  }
}
