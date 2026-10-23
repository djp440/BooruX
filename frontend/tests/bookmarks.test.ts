import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarkProvider, useBookmarks } from '../src/Bookmarks';
import type { Post } from '../src/feed';

function setupMockDOM() {
  class Element {
    nodeType = 1; nodeName = 'DIV'; tagName = 'DIV'; style = {}; childNodes: any[] = []; ownerDocument = null as any;
    addEventListener() {} removeEventListener() {} appendChild(c: any) { this.childNodes.push(c); return c; }
    removeChild(c: any) { return c; } insertBefore(c: any) { return c; } setAttribute() {} removeAttribute() {}
  }
  class Document {
    nodeType = 9; nodeName = '#document'; defaultView = null as any;
    createElement(tag: string) { const el = new Element(); el.nodeName = tag.toUpperCase(); el.tagName = tag.toUpperCase(); el.ownerDocument = this; return el; }
    createElementNS(_: any, tag: string) { return this.createElement(tag); }
    createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, ownerDocument: this }; }
    addEventListener() {} removeEventListener() {}
  }
  const storageMap = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => { storageMap.set(key, val); },
    removeItem: (key: string) => { storageMap.delete(key); },
    clear: () => { storageMap.clear(); },
  };
  const doc = new Document();
  const win = { document: doc, Element, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {}, localStorage: fakeStorage };
  doc.defaultView = win;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const originalWindow = globalThis.window;
  const originalDoc = globalThis.document;
  const originalStorage = globalThis.localStorage;

  globalThis.window = win as any;
  globalThis.document = doc as any;
  setLocalStorage(fakeStorage);

  return {
    doc,
    win,
    fakeStorage,
    restore: () => {
      globalThis.window = originalWindow;
      globalThis.document = originalDoc;
      setLocalStorage(originalStorage);
    },
  };
}

// bun 1.4 起 localStorage 是只读全局，不能直接赋值
function setLocalStorage(value: unknown) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

function mockPost(id: string): Post {
  return { id, parentId: null, title: id, imageUrl: `https://cdn.donmai.us/${id}.png`, mediaType: 'image', hasChildren: false, tags: [] };
}

describe('收藏状态与竞态锁', () => {
  test('冷启动若存在本地有效缓存，立即将 ready 初始化为 true，避免卡片收藏按钮被无谓禁用', async () => {
    const env = setupMockDOM();
    try {
      // 写入有效缓存
      env.fakeStorage.setItem('boorux:post-cache:v1', JSON.stringify({
        'favorites:default': {
          savedAt: Date.now(),
          data: {
            success: true,
            posts: [mockPost('danbooru-1')],
          },
        },
      }));

      let state: ReturnType<typeof useBookmarks> | null = null;
      function Consumer() {
        state = useBookmarks();
        return null;
      }

      const container = env.doc.createElement('div');
      const root = createRoot(container as any);
      await act(async () => {
        root.render(React.createElement(BookmarkProvider, null, React.createElement(Consumer)));
      });

      expect(state).not.toBeNull();
      expect(state!.ready).toBe(true);
      expect(state!.snapshot.posts.length).toBe(1);
      expect(state!.snapshot.posts[0].id).toBe('danbooru-1');

      await act(async () => { root.unmount(); });
    } finally {
      env.restore();
    }
  });

  test('冷启动无缓存时，ready 初始化为 false', async () => {
    const env = setupMockDOM();
    try {
      let state: ReturnType<typeof useBookmarks> | null = null;
      function Consumer() {
        state = useBookmarks();
        return null;
      }

      const container = env.doc.createElement('div');
      const root = createRoot(container as any);
      await act(async () => {
        root.render(React.createElement(BookmarkProvider, null, React.createElement(Consumer)));
      });

      expect(state).not.toBeNull();
      expect(state!.ready).toBe(false);
      expect(state!.snapshot.posts.length).toBe(0);

      await act(async () => { root.unmount(); });
    } finally {
      env.restore();
    }
  });

  test('clearBookmarks 触发时同步将全局 loading 设为 true，防止返回收藏列表时闪现“暂无收藏”假空状态', async () => {
    const env = setupMockDOM();
    try {
      // 模拟已存在缓存
      env.fakeStorage.setItem('boorux:post-cache:v1', JSON.stringify({
        'favorites:default': {
          savedAt: Date.now(),
          data: { success: true, posts: [mockPost('danbooru-1')] },
        },
      }));

      let state: ReturnType<typeof useBookmarks> | null = null;
      function Consumer() {
        state = useBookmarks();
        return null;
      }

      const container = env.doc.createElement('div');
      const root = createRoot(container as any);
      await act(async () => {
        root.render(React.createElement(BookmarkProvider, null, React.createElement(Consumer)));
      });

      // 此时准备就绪
      expect(state!.ready).toBe(true);

      // 调用 clear（如设置切换分级时）
      await act(async () => {
        state!.clear();
      });

      // 验证 loading 同步设为 true，ready 重置为 false，snapshot 清空
      expect(state!.loading).toBe(true);
      expect(state!.ready).toBe(false);
      expect(state!.snapshot.posts.length).toBe(0);

      await act(async () => { root.unmount(); });
    } finally {
      env.restore();
    }
  });

  test('refresh.finally 具备版本号校验，防止被作废的旧事务提前清空新事务的 request.current 引用与 loading 状态', async () => {
    const env = setupMockDOM();
    let resolveReq1!: (value: any) => void;
    let resolveReq2!: (value: any) => void;
    let callCount = 0;

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
      callCount++;
      if (callCount === 1) {
        return new Promise(resolve => {
          resolveReq1 = () => resolve(new Response(JSON.stringify({ success: true, bookmarks: [mockPost('req1-post')] })));
        });
      } else {
        return new Promise(resolve => {
          resolveReq2 = () => resolve(new Response(JSON.stringify({ success: true, bookmarks: [mockPost('req2-post')] })));
        });
      }
    }) as any);

    try {
      let state: ReturnType<typeof useBookmarks> | null = null;
      function Consumer() {
        state = useBookmarks();
        return null;
      }

      const container = env.doc.createElement('div');
      const root = createRoot(container as any);
      await act(async () => {
        root.render(React.createElement(BookmarkProvider, null, React.createElement(Consumer)));
      });

      // 1. 启动事务 1
      let req1Promise: Promise<void>;
      await act(async () => {
        req1Promise = state!.refresh();
      });
      expect(state!.loading).toBe(true);

      // 2. 模拟设置变更触发 clear（作废事务 1，revision 自增，loading 设为 true）
      await act(async () => {
        state!.clear();
      });
      expect(state!.loading).toBe(true);

      // 3. 启动事务 2（新 revision）
      let req2Promise: Promise<void>;
      await act(async () => {
        req2Promise = state!.refresh();
      });
      expect(state!.loading).toBe(true);

      // 4. 旧事务 1 完成
      await act(async () => {
        resolveReq1(null);
        await req1Promise;
      });

      // 关键断言：旧事务 1 完成时，因版本号已被作废，不得将 loading 提前置为 false！
      // 也不得将新事务 2 的数据覆盖为 req1 的旧数据
      expect(state!.loading).toBe(true);
      expect(state!.snapshot.posts).toEqual([]);

      // 5. 新事务 2 完成
      await act(async () => {
        resolveReq2(null);
        await req2Promise;
      });

      // 新事务完成，正常关闭 loading 并提交数据
      expect(state!.loading).toBe(false);
      expect(state!.ready).toBe(true);
      expect(state!.snapshot.posts.length).toBe(1);
      expect(state!.snapshot.posts[0].id).toBe('req2-post');

      await act(async () => { root.unmount(); });
    } finally {
      fetchSpy.mockRestore();
      env.restore();
    }
  });
});
