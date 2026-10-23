import { describe, expect, test } from 'bun:test';
import {
  beginRestore,
  createThrottledScrollHandler,
  handleAreaNav,
  PageSessions,
  positionTarget,
  restorePosition,
} from '../src/page-session';

function setupDOM() {
  const listeners = new Map<string, Function[]>();
  let scrollY = 0;
  const scrollToCalls: any[] = [];
  const querySelectorCalls: string[] = [];
  const querySelectorAllCalls: string[] = [];

  const fakeWindow = {
    get scrollY() { return scrollY; },
    set scrollY(v: number) { scrollY = v; },
    innerHeight: 800,
    scrollTo: (optionsOrX: any, y?: number) => {
      scrollToCalls.push(typeof optionsOrX === 'object' ? optionsOrX : { x: optionsOrX, y });
      if (typeof optionsOrX === 'number' && typeof y === 'number') {
        scrollY = y;
      } else if (typeof optionsOrX === 'object' && typeof optionsOrX.top === 'number') {
        scrollY = optionsOrX.top;
      }
    },
    addEventListener: (type: string, fn: Function) => {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, fn: Function) => {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter(cb => cb !== fn));
    },
  };

  const fakeDocument = {
    documentElement: { scrollHeight: 3000 },
    querySelector: (sel: string) => {
      querySelectorCalls.push(sel);
      return null;
    },
    querySelectorAll: (sel: string) => {
      querySelectorAllCalls.push(sel);
      return [];
    },
  };

  return {
    fakeWindow,
    fakeDocument,
    scrollToCalls,
    querySelectorCalls,
    querySelectorAllCalls,
    listeners,
  };
}

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
  test('从对话页打开的详情不算首页现场，返回对话后首页仍是列表', () => {
    const store = new PageSessions();
    const home = store.visit('h1', '/', 'POP');
    const chat = store.visit('c1', '/chat/abc', 'PUSH');
    const detail = store.open('/posts/9', chat, 'c1');
    store.visit('d1', detail.path, 'PUSH', detail.id);
    expect(store.lastVisit.home).toBe(home);
    expect(store.lastChat).toBe(chat);
    expect(store.backDelta(detail)).toBe(-1);
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

  test('PageSessions.prune 回收历史分支截断后的不可达孤立详情会话', () => {
    const store = new PageSessions();
    const list = store.visit('h1', '/', 'POP');
    const d1 = store.open('/posts/1', list, 'h1');
    store.visit('h2', d1.path, 'PUSH', d1.id);
    const d2 = store.open('/posts/2', list, 'h2');
    store.visit('h3', d2.path, 'PUSH', d2.id);

    expect(store.pages.has(d1.id)).toBe(true);
    expect(store.pages.has(d2.id)).toBe(true);

    // 回到首页并开辟新的导航分支 d3
    store.visit('h1', '/', 'POP');
    const d3 = store.open('/posts/3', list, 'h1');
    store.visit('h4', d3.path, 'PUSH', d3.id);

    // d1 与 d2 已不在 entries，不在 lastVisit，亦非活跃会话 origin，应被 prune 彻底回收
    store.prune();
    expect(store.pages.has(d1.id)).toBe(false);
    expect(store.pages.has(d2.id)).toBe(false);
    expect(store.pages.has(d3.id)).toBe(true);
    expect(store.pages.has('h1')).toBe(true);
  });

  test('PageSessions.prune 保留 lastVisit 中的跨区域会话与 origin 链路', () => {
    const store = new PageSessions();
    const homeList = store.visit('h1', '/', 'POP');
    const homeDetail = store.open('/posts/1', homeList, 'h1');
    store.visit('h2', homeDetail.path, 'PUSH', homeDetail.id);

    // 切换至收藏夹
    const favList = store.visit('f1', '/favorites', 'PUSH');
    store.prune();

    // homeDetail 仍保存在 lastVisit.home，homeList 是其 origin，均不可被误回收
    expect(store.pages.has(homeDetail.id)).toBe(true);
    expect(store.pages.has(homeList.id)).toBe(true);
    expect(store.pages.has(favList.id)).toBe(true);
  });

  test('restorePosition 无锚点时跳过 DOM 扫描直接按 y 坐标滚动', () => {
    const { fakeWindow, fakeDocument, scrollToCalls, querySelectorCalls, querySelectorAllCalls } = setupDOM();
    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

      restorePosition({ y: 1200, anchors: [] });
      expect(querySelectorCalls.length).toBe(0);
      expect(querySelectorAllCalls.length).toBe(0);
      expect(scrollToCalls).toContainEqual({ x: 0, y: 1200 });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    }
  });

  test('restorePosition 有锚点时仅定向查询最多 3 个目标锚点，杜绝 querySelectorAll 全量扫描', () => {
    const { fakeWindow, fakeDocument, querySelectorCalls, querySelectorAllCalls } = setupDOM();
    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

      restorePosition({
        y: 1500,
        anchors: [
          { id: 'a1', offset: 10 },
          { id: 'a2', offset: 20 },
          { id: 'a3', offset: 30 },
          { id: 'a4', offset: 40 },
          { id: 'a5', offset: 50 },
        ],
      });
      expect(querySelectorAllCalls.length).toBe(0);
      expect(querySelectorCalls.length).toBeGreaterThan(0);
      expect(querySelectorCalls.length).toBeLessThanOrEqual(3);
      expect(querySelectorCalls.some(s => s.includes('a1'))).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    }
  });

  test('beginRestore 检测到非程序化位移（如用户拖动原生滚动条）立即停止恢复循环', () => {
    const { fakeWindow, fakeDocument } = setupDOM();
    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    let rafCallback: FrameRequestCallback | null = null;
    let cancelCalled = false;
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;

    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCallback = cb;
        return 1;
      };
      globalThis.cancelAnimationFrame = () => {
        cancelCalled = true;
      };

      const cleanup = beginRestore({ y: 500, anchors: [] });
      expect(rafCallback).not.toBeNull();
      const frame1 = rafCallback!;
      rafCallback = null;
      frame1(100);

      expect(fakeWindow.scrollY).toBe(500);
      expect(rafCallback).not.toBeNull();

      // 用户拖动原生视口滚动条发生非程序化位移至 200
      fakeWindow.scrollY = 200;

      const frame2 = rafCallback!;
      rafCallback = null;
      frame2(116);

      // 应立即侦测到冲突并打断
      expect(cancelCalled).toBe(true);
      expect(fakeWindow.scrollY).toBe(200);

      cleanup();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancelRaf;
    }
  });

  test('原生滚动监听使用 requestAnimationFrame 标志位节流，单帧多次高频事件仅执行一次采集', () => {
    let frameCallback: FrameRequestCallback | null = null;
    let rafCount = 0;
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;

    try {
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCount++;
        frameCallback = cb;
        return rafCount;
      };
      globalThis.cancelAnimationFrame = () => {};

      let executions = 0;
      const { handleScroll, cancel } = createThrottledScrollHandler(() => {
        executions++;
      });

      // 模拟高刷显示器单帧内高频产生 10 次滚动事件
      for (let i = 0; i < 10; i++) {
        handleScroll();
      }

      // requestAnimationFrame 只被调度了 1 次
      expect(rafCount).toBe(1);
      expect(executions).toBe(0);

      // 帧回调执行
      expect(frameCallback).not.toBeNull();
      frameCallback!(16);
      expect(executions).toBe(1);

      // 帧结束后再次发生滚动，可正常调度下一帧
      handleScroll();
      expect(rafCount).toBe(2);

      cancel();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });

  test('主导航在当前列表激活项重复点击时平滑回顶并重置坐标为 (0, 0)', () => {
    const store = new PageSessions();
    const home = store.visit('h1', '/', 'POP');
    home.position = { y: 1600, anchors: [{ id: 'p1', offset: 50 }] };

    const smoothScrollCalls: any[] = [];
    const navigateCalls: any[] = [];

    // 在首页且当前路径为 '/'，再次点击首页导航
    const result1 = handleAreaNav(
      'home',
      '/',
      home,
      store,
      (path, opts) => navigateCalls.push({ path, opts }),
      opts => smoothScrollCalls.push(opts),
    );

    expect(result1).toBe('scroll_to_top');
    expect(smoothScrollCalls).toEqual([{ top: 0, behavior: 'smooth' }]);
    expect(home.position).toEqual({ y: 0, anchors: [] });
    expect(navigateCalls.length).toBe(0);

    // 当处于详情页 '/posts/1' 时点击首页导航，应执行导航而非原地回顶
    const detail = store.open('/posts/1', home, 'h1');
    store.visit('h2', detail.path, 'PUSH', detail.id);
    detail.position = { y: 300, anchors: [] };

    const result2 = handleAreaNav(
      'home',
      '/posts/1',
      detail,
      store,
      (path, opts) => navigateCalls.push({ path, opts }),
      opts => smoothScrollCalls.push(opts),
    );

    expect(result2).toBe('navigated');
    expect(navigateCalls.length).toBe(1);
    expect(detail.position.y).toBe(300);
  });
});
