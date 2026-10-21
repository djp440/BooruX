import { describe, expect, test } from 'bun:test';
import { clearSearchHistory, normalizeTagQuery, readSearchHistory, saveSearchHistory, searchCacheKey } from '../src/search';
import { readPostCache, writePostCache } from '../src/post-cache';
import type { PostsResponse } from '../src/feed';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('首页 tag 搜索', () => {
  test('多个 tag 规整空白，不修改下划线及标签内容', () => {
    expect(normalizeTagQuery('  sky\n blue_hair\t hatsune_miku  ')).toBe('sky blue_hair hatsune_miku');
    expect(normalizeTagQuery(' \n ')).toBe('');
  });
  test('按查询隔离结果及游标，不覆盖默认首页', () => {
    const store = storage();
    const home: PostsResponse = { success: true, posts: [], nextCursor: 'd:100' };
    const search: PostsResponse = { success: true, posts: [], nextCursor: 'd:50' };
    writePostCache(searchCacheKey(''), home, store);
    writePostCache(searchCacheKey('sky blue_hair'), search, store);
    expect(searchCacheKey('')).toBe('feed:default');
    expect(searchCacheKey('   ')).toBe('feed:default');
    expect(searchCacheKey('  sky   blue_hair  ')).toBe('feed:default:tags:sky blue_hair');
    expect(searchCacheKey('\n  hatsune_miku\t\t vocaloid  \n')).toBe('feed:default:tags:hatsune_miku vocaloid');
    expect(readPostCache(searchCacheKey(''), store)?.data).toEqual(home);
    expect(readPostCache(searchCacheKey('sky blue_hair'), store)?.data).toEqual(search);
    expect(readPostCache(searchCacheKey('blue_hair'), store)).toBeNull();
  });
  test('搜索历史去重前移、保留20条，空查询不记入，支持读取和清空', () => {
    const store = storage();
    let history: string[] = [];
    for (let i = 0; i < 21; i++) history = saveSearchHistory(history, `tag_${i} sky`, store);
    expect(history).toHaveLength(20);
    expect(history).not.toContain('tag_0 sky');
    history = saveSearchHistory(history, ' tag_5   sky ', store);
    expect(history[0]).toBe('tag_5 sky');
    expect(history.filter(item => item === 'tag_5 sky')).toHaveLength(1);
    expect(saveSearchHistory(history, ' ', store)).toEqual(history);
    expect(readSearchHistory(store)).toEqual(history);
    clearSearchHistory(store);
    expect(readSearchHistory(store)).toEqual([]);
  });
  test('损坏记录、不可信类型、超长记录和存储不可用不会阻断搜索', () => {
    const store = storage();
    store.setItem('boorux:tag-search-history:v1', '{bad');
    expect(readSearchHistory(store)).toEqual([]);
    store.setItem('boorux:tag-search-history:v1', JSON.stringify([null, 1, '  sky  ', 'sky', '', 'x'.repeat(501)]));
    expect(readSearchHistory(store)).toEqual(['sky']);
    const unavailable = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } };
    expect(readSearchHistory(unavailable)).toEqual([]);
    expect(saveSearchHistory([], 'sky blue_hair', unavailable)).toEqual(['sky blue_hair']);
    expect(() => clearSearchHistory(unavailable)).not.toThrow();
  });
});
