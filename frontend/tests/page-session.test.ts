import { describe, expect, test } from 'bun:test';
import { PageSessions, positionTarget } from '../src/page-session';

describe('详情页面内存会话', () => {
  test('列表→详情→收藏→首页详情→返回，保留原列表和评论', () => {
    const store = new PageSessions();
    const list = store.visit('h1', '/', 'POP');
    list.position = { y: 1200, anchors: [] };
    list.feed = { success: true, posts: [], nextCursor: 'page3' };
    const detail = store.open('/posts/danbooru-1', list, 'h1');
    store.visit('h2', detail.path, 'PUSH', detail.id);
    detail.position.y = 650;
    detail.comments = { streams: [], displayed: [] };
    store.visit('f1', '/favorites', 'PUSH');
    expect(store.lastVisit.home).toBe(detail);
    const restored = store.visit('h3', detail.path, 'PUSH', store.lastVisit.home?.id);
    expect(restored).toBe(detail);
    expect(restored.comments).toBe(detail.comments);
    expect(restored.position.y).toBe(650);
    expect(store.backDelta(restored)).toBe(-3);
    expect(store.visit('h1', '/', 'POP')).toBe(list);
    expect(list.feed.nextCursor).toBe('page3');
    expect(list.position.y).toBe(1200);
    expect(store.visit('h3', detail.path, 'POP')).toBe(detail);
  });
  test('两导航各自详情，同 URL 不同进入来源，POP 与前进不会覆盖来源', () => {
    const store = new PageSessions();
    const home = store.visit('h1', '/', 'POP');
    const first = store.open('/posts/1', home, 'h1');
    store.visit('h2', first.path, 'PUSH', first.id);
    const favorites = store.visit('f1', '/favorites', 'PUSH');
    const favoriteDetail = store.open('/favorites/posts/2', favorites, 'f1');
    store.visit('f2', favoriteDetail.path, 'PUSH', favoriteDetail.id);
    expect(store.lastVisit.home).toBe(first);
    expect(store.lastVisit.favorites).toBe(favoriteDetail);
    store.visit('h2', first.path, 'POP');
    const homeAgain = store.visit('h3', '/', 'PUSH');
    const second = store.open('/posts/1', homeAgain, 'h3');
    store.visit('h4', second.path, 'PUSH', second.id);
    expect(first.origin?.key).toBe('h1');
    expect(second.origin?.key).toBe('h3');
    expect(first.id).not.toBe(second.id);
    expect(store.entries.some(entry => entry.key === 'f2')).toBe(false);
  });
  test('直达详情没有来源，刷新创建空会话；原 entry 丢失时可引用保存快照', () => {
    const store = new PageSessions();
    const direct = store.visit('d1', '/favorites/posts/1', 'POP');
    expect(direct.origin).toBeUndefined(); expect(store.backDelta(direct)).toBeNull();
    expect(direct.position.y).toBe(0); expect(direct.comments).toBeUndefined();
    const list = store.visit('l1', '/favorites', 'PUSH');
    const detail = store.open('/favorites/posts/2', list, 'l1');
    store.entries = []; store.index = -1;
    store.visit('d2', detail.path, 'POP', detail.id);
    expect(store.backDelta(detail)).toBeNull();
    expect(detail.origin?.sessionId).toBe(list.id);
  });
  test('收藏卡片消失先恢复后继再前驱，最后夹取滚动或空列表顶部', () => {
    const position = { y: 1500, anchors: [{ id: 'gone', offset: -100 }, { id: 'next', offset: 500 }, { id: 'previous', offset: -700 }] };
    expect(positionTarget(position, [{ id: 'next', top: 1800 }, { id: 'previous', top: 600 }], 3000)).toBe(1300);
    expect(positionTarget(position, [{ id: 'previous', top: 600 }], 3000)).toBe(1300);
    expect(positionTarget(position, [], 900)).toBe(900);
    expect(positionTarget(position, [], 0)).toBe(0);
  });
});
