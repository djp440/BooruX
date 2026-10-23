import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { RATING_OPTIONS, THEME_OPTIONS, THEME_STORAGE_KEY, applyTheme, isRating, isTheme, normalizeFilterTag, readCachedTheme, readTagFilter } from '../src/rating-settings';
import { PageSessions } from '../src/page-session';
import { addedModels, candidateModels, mainModelOptions } from '../src/ai-providers';
import type { Provider } from '../src/ai-providers';
import { clearPostsCache, postsCacheSize, readPostCache, writePostCache } from '../src/post-cache';

function storage() {
  let raw: string | null = null;
  return { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
}

describe('AI 供应商模型', () => {
  const provider = (id: string, models: [string, number, number][]): Provider => ({
    id, name: id.toUpperCase(), baseUrl: 'http://x', protocol: 'openai', hasKey: false, discoveryError: null,
    models: models.map(([model, manual, available]) => ({ id: model, name: model, manual, available })),
  });
  const a = provider('a', [['gpt-4o', 1, 1], ['gpt-4o-mini', 0, 1], ['old', 0, 0], ['custom', 1, 0]]);

  test('manual 区分已加入与候选，下架的候选不显示', () => {
    expect(addedModels(a).map(m => m.id)).toEqual(['gpt-4o', 'custom']);
    expect(candidateModels(a, '').map(m => m.id)).toEqual(['gpt-4o-mini']);
    expect(candidateModels(a, 'MINI').map(m => m.id)).toEqual(['gpt-4o-mini']);
    expect(candidateModels(a, 'claude')).toEqual([]);
  });

  test('主模型选项汇总所有供应商已加入的模型', () => {
    expect(mainModelOptions([a, provider('b', [['m', 1, 1]])])).toEqual([
      { providerId: 'a', modelId: 'gpt-4o', label: 'A / gpt-4o' },
      { providerId: 'a', modelId: 'custom', label: 'A / custom' },
      { providerId: 'b', modelId: 'm', label: 'B / m' },
    ]);
  });
});

describe('标签屏蔽与本地数据', () => {
  test('屏蔽标签按后端规则规整：去 #、小写、空白转下划线、限长 100', () => {
    expect(normalizeFilterTag('  #Blue Hair ')).toBe('blue_hair');
    expect(normalizeFilterTag('###')).toBe('');
    expect(normalizeFilterTag('a'.repeat(150))).toHaveLength(100);
  });

  test('tagFilter 清洗：非对象回退为关闭，只保留字符串标签并保留白名单等字段', () => {
    expect(readTagFilter(null)).toEqual({ blacklistEnabled: false, blacklist: [] });
    expect(readTagFilter(['x'])).toEqual({ blacklistEnabled: false, blacklist: [] });
    expect(readTagFilter({ blacklistEnabled: 'yes', blacklist: ['gore', 1, null], whitelist: ['cat'] }))
      .toEqual({ blacklistEnabled: false, blacklist: ['gore'], whitelist: ['cat'] });
  });

  test('缓存大小：空缓存与清空后为 0，写入后为正数', () => {
    const store = storage();
    expect(postsCacheSize(store)).toBe(0);
    writePostCache('home', { success: true, posts: [], nextCursor: '' }, store);
    expect(postsCacheSize(store)).toBeGreaterThan(0);
    clearPostsCache(store);
    expect(postsCacheSize(store)).toBe(0);
  });
});

describe('设置页背景色', () => {
  function fakeDocument() {
    const attributes = new Map<string, string>();
    const values = new Map<string, string>();
    const root = {
      dataset: {
        get theme() { return attributes.get('data-theme'); },
        set theme(value: string | undefined) {
          if (typeof value === 'string') attributes.set('data-theme', value);
          else attributes.delete('data-theme');
        },
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
  test('单选卡片选中态高对比度底色与文本边框，消除不可见对比与禁用语义反转', async () => {
    const css = await Bun.file(resolve(__dirname, '../src/style.css')).text();
    expect(css).toMatch(/--selected-bg:\s*#f3f4f6;/);
    expect(css).toMatch(/\.rating-option:has\(input:checked\)\s*\{[^}]*border-color:\s*var\(--text\);/);
  });
  test('applyTheme 支持纯预览模式（persist: false），修改 DOM 但不写入 localStorage', () => {
    const { root, storage } = fakeDocument();
    const originalDocument = globalThis.document;
    const originalStorage = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
      // 预先存入已保存的主题 light
      storage.setItem(THEME_STORAGE_KEY, 'light');

      // 纯预览模式切换为 dark
      applyTheme('dark', false);
      expect(globalThis.document.documentElement.dataset.theme).toBe('dark');
      // localStorage 应保持原本保存的 light，未被持久化
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');

      // 纯预览模式切换为 system
      applyTheme('system', false);
      expect(globalThis.document.documentElement.dataset.theme).toBeUndefined();
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');

      // 持久化模式保存为 dark
      applyTheme('dark', true);
      expect(globalThis.document.documentElement.dataset.theme).toBe('dark');
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    }
  });

  test('未保存离开设置页时，自动回滚 DOM 外观至已保存的主题', async () => {
    // 准备 mock DOM 环境与 Settings 渲染
    let datasetTheme: string | undefined;
    const rootEl = {
      dataset: {
        get theme() { return datasetTheme; },
        set theme(val: string | undefined) { datasetTheme = val; },
      },
      removeAttribute: () => { datasetTheme = undefined; },
    };

    class Element {
      nodeType = 1; nodeName = 'DIV'; tagName = 'DIV'; style = {}; childNodes: any[] = []; ownerDocument = null as any;
      addEventListener() {} removeEventListener() {} appendChild(c: any) { this.childNodes.push(c); return c; }
      removeChild(c: any) { return c; } insertBefore(c: any) { return c; } setAttribute() {} removeAttribute() {}
      focus() {}
    }
    class Document {
      nodeType = 9; nodeName = '#document'; defaultView = null as any;
      documentElement = rootEl;
      createElement(tag: string) { const el = new Element(); el.nodeName = tag.toUpperCase(); el.tagName = tag.toUpperCase(); el.ownerDocument = this; return el; }
      createElementNS(_: any, tag: string) { return this.createElement(tag); }
      createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, ownerDocument: this }; }
      addEventListener() {} removeEventListener() {}
    }

    const doc = new Document();
    const win = {
      document: doc, Element, HTMLIFrameElement: class {},
      addEventListener() {}, removeEventListener() {},
      history: { scrollRestoration: 'auto' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: Function) => setTimeout(cb, 16),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
    };
    doc.defaultView = win;

    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 16);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, settings: { rating: 'general', themeMode: 'light' } })))
    ) as any);

    try {
      const { MemoryRouter } = await import('react-router');
      const { PageSessionProvider } = await import('../src/page-session');
      const { BookmarkProvider } = await import('../src/Bookmarks');
      const { default: Settings } = await import('../src/Settings');
      const { createRoot } = await import('react-dom/client');

      const container = doc.createElement('div');
      const root = createRoot(container as any);

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, null,
            React.createElement(PageSessionProvider, null,
              React.createElement(BookmarkProvider, null,
                React.createElement(Settings)
              )
            )
          )
        );
      });

      // 加载完成后 DOM 应为 light
      expect(datasetTheme as string | undefined).toBe('light');

      // 切换预览为 dark (模拟单选触发 applyTheme('dark', false))
      applyTheme('dark', false);
      expect(datasetTheme as string | undefined).toBe('dark');

      // 用户未保存直接离开页面（组件卸载）
      await act(async () => {
        root.unmount();
      });

      // 卸载后应自动回滚为 light
      expect(datasetTheme as string | undefined).toBe('light');
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    }
  });

  test('保存失败重试与加载失败重试解耦，重试保存不调用 fetchSettings 冲刷用户草稿', async () => {
    let datasetTheme: string | undefined;
    const rootEl = {
      dataset: {
        get theme() { return datasetTheme; },
        set theme(val: string | undefined) { datasetTheme = val; },
      },
      removeAttribute: () => { datasetTheme = undefined; },
    };

    const focusedElements: any[] = [];
    class Element {
      nodeType = 1; nodeName = 'DIV'; tagName = 'DIV'; style = {}; childNodes: any[] = []; ownerDocument = null as any;
      type?: string; name?: string; value?: string; checked?: boolean; disabled?: boolean;
      addEventListener() {} removeEventListener() {} appendChild(c: any) { this.childNodes.push(c); return c; }
      removeChild(c: any) { return c; } insertBefore(c: any) { return c; } setAttribute() {} removeAttribute() {}
      focus() { focusedElements.push(this); }
    }
    class Document {
      nodeType = 9; nodeName = '#document'; defaultView = null as any;
      documentElement = rootEl;
      createElement(tag: string) { const el = new Element(); el.nodeName = tag.toUpperCase(); el.tagName = tag.toUpperCase(); el.ownerDocument = this; return el; }
      createElementNS(_: any, tag: string) { return this.createElement(tag); }
      createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, ownerDocument: this }; }
      addEventListener() {} removeEventListener() {}
    }

    const doc = new Document();
    const win = {
      document: doc, Element, HTMLIFrameElement: class {},
      addEventListener() {}, removeEventListener() {},
      history: { scrollRestoration: 'auto' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: Function) => setTimeout(cb, 16),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
    };
    doc.defaultView = win;

    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 16);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });

    let getSettingsCalls = 0;
    let putSettingsCalls = 0;
    let lastPutBody: any = null;

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((input: any, init?: any) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.includes('/api/settings') && method === 'GET') {
        getSettingsCalls++;
        return Promise.resolve(new Response(JSON.stringify({ success: true, settings: { rating: 'general', themeMode: 'light' } })));
      }
      if (url.includes('/api/settings') && method === 'PUT') {
        putSettingsCalls++;
        lastPutBody = JSON.parse(String(init?.body || '{}'));
        if (putSettingsCalls === 1) {
          // 首次保存失败
          return Promise.resolve(new Response(JSON.stringify({ success: false, error: '网络保存异常' }), { status: 500 }));
        }
        // 重试保存成功
        return Promise.resolve(new Response(JSON.stringify({ success: true, settings: { rating: lastPutBody.rating || 'general', themeMode: 'light' } })));
      }
      return Promise.resolve(new Response('{}'));
    }) as any);

    try {
      const { MemoryRouter } = await import('react-router');
      const { PageSessionProvider } = await import('../src/page-session');
      const { BookmarkProvider } = await import('../src/Bookmarks');
      const { default: Settings } = await import('../src/Settings');
      const { createRoot } = await import('react-dom/client');

      const container = doc.createElement('div');
      const root = createRoot(container as any);

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, null,
            React.createElement(PageSessionProvider, null,
              React.createElement(BookmarkProvider, null,
                React.createElement(Settings)
              )
            )
          )
        );
      });

      expect(getSettingsCalls).toBe(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    }
  });

  test('点击“取消更改”时主动将焦点重定向至当前激活的单选项，避免禁用按钮导致焦点跌落至 body', async () => {
    let focusedElement: any = null;
    const rootEl = {
      dataset: { theme: undefined },
      removeAttribute: () => {},
    };

    function findElements(node: any, match: (el: any) => boolean): any[] {
      const results: any[] = [];
      if (match(node)) results.push(node);
      for (const child of node.childNodes || []) {
        results.push(...findElements(child, match));
      }
      return results;
    }

    class Element {
      nodeType = 1; nodeName = 'DIV'; tagName = 'DIV'; style = {}; childNodes: any[] = []; ownerDocument = null as any;
      type?: string; name?: string; value?: string; checked?: boolean; disabled?: boolean;
      addEventListener() {} removeEventListener() {} appendChild(c: any) { this.childNodes.push(c); return c; }
      removeChild(c: any) { return c; } insertBefore(c: any) { return c; } setAttribute() {} removeAttribute() {}
      focus() { focusedElement = this; }
      querySelector(selector: string): any {
        const matchVal = selector.match(/input\[value="([^"]+)"\]/);
        if (matchVal) {
          return findElements(this, el => el.nodeName === 'INPUT' && el.value === matchVal[1])[0] || null;
        }
        return null;
      }
    }
    class Document {
      nodeType = 9; nodeName = '#document'; defaultView = null as any;
      documentElement = rootEl;
      createElement(tag: string) { const el = new Element(); el.nodeName = tag.toUpperCase(); el.tagName = tag.toUpperCase(); el.ownerDocument = this; return el; }
      createElementNS(_: any, tag: string) { return this.createElement(tag); }
      createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, ownerDocument: this }; }
      addEventListener() {} removeEventListener() {}
    }

    const doc = new Document();
    const win = {
      document: doc, Element, HTMLIFrameElement: class {},
      addEventListener() {}, removeEventListener() {},
      history: { scrollRestoration: 'auto' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: Function) => setTimeout(cb, 16),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
    };
    doc.defaultView = win;

    const origWindow = globalThis.window;
    const origDoc = globalThis.document;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 16);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, settings: { rating: 'general', themeMode: 'system' } })))
    ) as any);

    try {
      const { MemoryRouter } = await import('react-router');
      const { PageSessionProvider } = await import('../src/page-session');
      const { BookmarkProvider } = await import('../src/Bookmarks');
      const { default: Settings } = await import('../src/Settings');
      const { createRoot } = await import('react-dom/client');

      const container = doc.createElement('div');
      const root = createRoot(container as any);

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, null,
            React.createElement(PageSessionProvider, null,
              React.createElement(BookmarkProvider, null,
                React.createElement(Settings)
              )
            )
          )
        );
      });

      function getReactProps(node: any): any {
        const key = Object.keys(node).find(k => k.startsWith('__reactProps'));
        return key ? node[key] : {};
      }

      // 找到主题单选框中的 'dark' 选项（当前已保存值为 'system'）
      const darkRadio = findElements(container, el => el.nodeName === 'INPUT' && el.value === 'dark')[0];
      expect(darkRadio).toBeDefined();

      const props = getReactProps(darkRadio);

      // 用户临时切换预览为 'dark'
      await act(async () => {
        props.onChange?.({ target: darkRadio });
      });

      // 此时表单呈现“取消更改”按钮
      const cancelButtons = findElements(container, el => el.nodeName === 'BUTTON' && el.textContent === '取消更改');
      expect(cancelButtons.length).toBeGreaterThan(0);
      const cancelBtn = cancelButtons[0];

      // 用户点击“取消更改”
      await act(async () => {
        getReactProps(cancelBtn).onClick?.();
      });

      // 验证焦点主动重定向到当前激活/恢复的 'system' 单选框，避免禁用状态导致焦点跌落至 body
      expect(focusedElement).toBeDefined();
      expect(focusedElement.nodeName).toBe('INPUT');
      expect(focusedElement.value).toBe('system');
      expect(focusedElement.disabled).toBeFalsy();

      await act(async () => {
        root.unmount();
      });
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    }
  });

  test('Refactoring UI 规范：.settings 约束 max-width: 600px 且提示框胶囊化', () => {
    const cssPath = resolve(__dirname, '../src/style.css');
    const css = readFileSync(cssPath, 'utf-8');

    // 表单宽度限制为 600px
    expect(css).toMatch(/\.settings\s*\{[^}]*max-width:\s*600px;/);
    // 提示条胶囊背景与内边距
    expect(css).toMatch(/\.setting-notice[^{]*\{[^}]*background:\s*var\(--subtle\);/);
    expect(css).toMatch(/\.setting-error[^{]*\{[^}]*background:\s*var\(--subtle\);/);
  });
});
