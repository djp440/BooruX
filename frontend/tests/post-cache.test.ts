import { describe, expect, spyOn, test } from 'bun:test';
import { isFresh, readPostCache, readPostDetailCache, removePostCache, writePostCache } from '../src/post-cache';
import type { PostDetailData } from '../src/comments';
import type { PostsResponse } from '../src/feed';

const data: PostsResponse = {
  success: true,
  posts: [{ id: 'danbooru-1', title: '缓存帖子', imageUrl: '/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Foriginal%2Fa.png', mediaType: 'image', parentId: null, hasChildren: true, tags: [{ id: 'tag-sky', name: 'sky', category: 'general' }] }],
  nextCursor: 'd:1',
  source: 'danbooru',
};

function storage() {
  let raw: string | null = null;
  return {
    getItem: () => raw,
    setItem: (_key: string, value: string) => { raw = value; },
    age: (milliseconds: number) => {
      const entries = JSON.parse(raw || '{}');
      for (const entry of Object.values(entries) as { savedAt: number }[]) entry.savedAt -= milliseconds;
      raw = JSON.stringify(entries);
    },
  };
}

describe('帖子缓存', () => {
  test('保存完整帖子、分页游标及父子帖元数据，按 key 隔离', () => {
    const store = storage();
    writePostCache('feed:default', data, store);
    writePostCache('family:default:danbooru-1', { ...data, nextCursor: '' }, store);
    expect(readPostCache('feed:default', store)?.data).toEqual(data);
    expect(readPostCache('family:default:danbooru-1', store)?.data.nextCursor).toBe('');
    expect(readPostCache('feed:other-profile', store)).toBeNull();
    expect(isFresh(readPostCache('feed:default', store)!)).toBe(true);
  });

  test('首页和收藏的列表缓存互不覆盖，关联媒体可以共用缓存', () => {
    const store = storage();
    const favorites = { ...data, posts: [{ ...data.posts[0], id: 'danbooru-2' }] };
    writePostCache('feed:default', data, store);
    writePostCache('favorites:default', favorites, store);
    writePostCache('family:default:danbooru-1', data, store);
    expect(readPostCache('feed:default', store)?.data.posts[0].id).toBe('danbooru-1');
    expect(readPostCache('favorites:default', store)?.data.posts[0].id).toBe('danbooru-2');
    expect(readPostCache('family:default:danbooru-1', store)?.data).toEqual(data);
  });

  test('超过 5 分钟可先恢复再更新，超过 24 小时不再恢复', () => {
    const store = storage();
    writePostCache('feed', data, store);
    store.age(6 * 60 * 1000);
    const stale = readPostCache('feed', store);
    expect(stale?.data).toEqual(data);
    expect(isFresh(stale!)).toBe(false);
    store.age(24 * 60 * 60 * 1000);
    expect(readPostCache('feed', store)).toBeNull();
  });

  test('损坏的 JSON 和不完整的帖子不会使页面崩溃，写入时可恢复', () => {
    const store = storage();
    store.setItem('', '{bad json');
    expect(readPostCache('feed', store)).toBeNull();
    writePostCache('feed', data, store);
    expect(readPostCache('feed', store)?.data).toEqual(data);
    store.setItem('', JSON.stringify({ feed: { savedAt: Date.now(), data: { success: true, posts: [{ id: 123 }] } } }));
    expect(readPostCache('feed', store)).toBeNull();
  });

  test('详情保留组元数据且与列表隔离，失效时只移除对应详情', () => {
    const store = storage();
    const detail: PostDetailData = { ...data, groupId: 'danbooru-1', familyComplete: true, commentsAvailability: 'available' };
    const key = 'detail:default:danbooru-1';
    writePostCache('feed:default', data, store);
    writePostCache(key, detail, store);
    expect(readPostDetailCache(key, store)).toEqual(detail);
    expect(readPostDetailCache('feed:default', store)).toBeNull();
    expect(readPostDetailCache('detail:other:danbooru-1', store)).toBeNull();
    removePostCache(key, store);
    expect(readPostDetailCache(key, store)).toBeNull();
    expect(readPostCache('feed:default', store)?.data).toEqual(data);
    writePostCache(key, detail, store);
    store.age(24 * 60 * 60 * 1000 + 1);
    expect(readPostDetailCache(key, store)).toBeNull();
  });

  test('损坏详情字段不作为可用详情，缓存不可用可降级', () => {
    const store = storage();
    const key = 'detail:default:danbooru-1';
    const detail: PostDetailData = { ...data, groupId: 'danbooru-1', familyComplete: true, commentsAvailability: 'available' };
    for (const invalid of [{ ...detail, groupId: 'danbooru-2' }, { ...detail, familyComplete: 'yes' }, { ...detail, commentsAvailability: 'invalid' }]) {
      writePostCache(key, invalid, store);
      expect(readPostDetailCache(key, store)).toBeNull();
    }
    const unavailable = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } };
    expect(readPostDetailCache(key, unavailable)).toBeNull();
    expect(() => removePostCache(key, unavailable)).not.toThrow();
  });

  test('缓存最多保留 40 项，原始媒体字节不写入本地存储', () => {
    const store = storage();
    for (let i = 0; i < 41; i++) writePostCache(`family:${i}`, data, store);
    expect(Object.keys(JSON.parse(store.getItem()!))).toHaveLength(40);
    expect(readPostCache('family:0', store)).toBeNull();
    expect(readPostCache('family:40', store)?.data).toEqual(data);
    expect(store.getItem()).not.toContain('base64');
  });

  test('超大结果与存储不可用时正常降级，不覆盖已有有效缓存', () => {
    const store = storage();
    writePostCache('feed', data, store);
    const before = store.getItem();
    writePostCache('large', { ...data, posts: [{ ...data.posts[0], title: 'x'.repeat(2 * 1024 * 1024) }] }, store);
    expect(store.getItem()).toBe(before);
    const unavailable = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } };
    expect(readPostCache('feed', unavailable)).toBeNull();
    expect(() => writePostCache('feed', data, unavailable)).not.toThrow();
  });

  test('总序列化体积超过 MAX_SIZE 时主动淘汰最旧项直到容纳新项，单项超大则安全放弃', () => {
    const store = storage();
    const largeTitle = 'a'.repeat(400 * 1024);
    const item1: PostsResponse = { ...data, posts: [{ ...data.posts[0], id: 'item-1', title: largeTitle }] };
    const item2: PostsResponse = { ...data, posts: [{ ...data.posts[0], id: 'item-2', title: largeTitle }] };
    const item3: PostsResponse = { ...data, posts: [{ ...data.posts[0], id: 'item-3', title: largeTitle }] };

    writePostCache('item:1', item1, store);
    store.age(2000);
    writePostCache('item:2', item2, store);
    store.age(1000);

    // 写入第 3 项，此时 3 项总和超过 MAX_SIZE (2 MiB)
    writePostCache('item:3', item3, store);

    // 最旧的 item:1 应被淘汰，而 item:2 与 item:3 应被保留
    expect(readPostCache('item:1', store)).toBeNull();
    expect(readPostCache('item:2', store)).not.toBeNull();
    expect(readPostCache('item:3', store)).not.toBeNull();
  });

  test('writePostCache 在内存中完成淘汰，写入过程单次最多调用 1 次 JSON.stringify', () => {
    const store = storage();
    // 预填 40 项
    for (let i = 0; i < 40; i++) writePostCache(`feed:${i}`, data, store);
    
    // 写入第 41 项触发淘汰，监听 JSON.stringify
    const stringifySpy = spyOn(JSON, 'stringify');
    try {
      writePostCache('feed:41', data, store);
      // 整个写入过程单次最多只调用 1 次 JSON.stringify
      expect(stringifySpy).toHaveBeenCalledTimes(1);
    } finally {
      stringifySpy.mockRestore();
    }
  });

  test('removePostCache 在 key 不存在时直接 return，不执行 setItem 写回', () => {
    let setItemCalls = 0;
    const store = {
      getItem: () => JSON.stringify({ 'feed:1': { savedAt: Date.now(), data } }),
      setItem: () => { setItemCalls++; },
    };

    // key 不存在
    removePostCache('feed:nonexistent', store);
    expect(setItemCalls).toBe(0);

    // key 存在
    removePostCache('feed:1', store);
    expect(setItemCalls).toBe(1);
  });
});
