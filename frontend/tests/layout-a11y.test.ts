import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Layout } from '../src/App';
import { BookmarkProvider } from '../src/Bookmarks';
import { PageSessionProvider } from '../src/page-session';

describe('768px 版心重构、吸顶安全区与全局高对比度无障碍 (Issue #16)', () => {
  const cssPath = resolve(__dirname, '../src/style.css');
  const css = readFileSync(cssPath, 'utf-8');
  const indexPath = resolve(__dirname, '../index.html');
  const indexHtml = readFileSync(indexPath, 'utf-8');
  const appPath = resolve(__dirname, '../src/App.tsx');
  const appTsx = readFileSync(appPath, 'utf-8');

  describe('1. 768px 版心重构规范', () => {
    test('媒体查询 @media (min-width: 768px) 下采用 200px 固定侧栏与 1200px 居中版心', () => {
      expect(css).toContain('@media (min-width: 768px)');
      // app-shell 具备 200px 侧栏 + 1200px 最大版心，居中及 16px 边距
      expect(css).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*200px minmax\(0,\s*1fr\);/);
      expect(css).toMatch(/\.app-shell\s*\{[^}]*max-width:\s*1200px;/);
      expect(css).toMatch(/\.app-shell\s*\{[^}]*margin:\s*0 auto;/);
      expect(css).toMatch(/\.app-shell\s*\{[^}]*padding:\s*0 16px;/);
      // navigation 声明 width: 200px
      expect(css).toMatch(/\.navigation\s*\{[^}]*width:\s*200px;/);
      // 旧 15% 边距已被废弃
      expect(css).not.toContain('padding: 0 15%;');
    });
  });

  describe('2. 画布与表面解耦 (Canvas vs Surface) 与微阴影', () => {
    test('定义 --canvas 与 --surface 语义色并区分抬升表面', () => {
      // 浅色模式
      expect(css).toMatch(/--canvas:\s*#f8f9fa;/);
      expect(css).toMatch(/--surface:\s*#fff;/);
      expect(css).toMatch(/--card-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.06\),\s*0 1px 2px rgba\(0,\s*0,\s*0,\s*0\.04\);/);

      // 暗色模式
      expect(css).toMatch(/--canvas:\s*#111215;/);
      expect(css).toMatch(/--surface:\s*#18191d;/);
      expect(css).toMatch(/--card-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.4\);/);

      // body 背景使用 var(--canvas)
      expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--canvas\);/);

      // 卡片引入 var(--surface) 与 var(--card-shadow)
      expect(css).toMatch(/\.post-card\s*\{[^}]*background:\s*var\(--surface\);/);
      expect(css).toMatch(/\.post-card\s*\{[^}]*box-shadow:\s*var\(--card-shadow\);/);
    });
  });

  describe('3. Viewport 安全区与 iOS WebKit 兼容', () => {
    test('index.html 中 meta viewport 包含 viewport-fit=cover', () => {
      expect(indexHtml).toMatch(/<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']/);
    });
  });

  describe('4. 吸顶头部与评论锚点安全区适配', () => {
    test('.detail-header 与 .comments 计算并预留 safe-area-inset-top', () => {
      expect(css).toMatch(/\.detail-header\s*\{[^}]*min-height:\s*calc\(60px \+ env\(safe-area-inset-top,\s*0px\)\);/);
      expect(css).toMatch(/\.detail-header\s*\{[^}]*padding:[^}]*env\(safe-area-inset-top,\s*0px\)/);
      expect(css).toMatch(/\.comments\s*\{[^}]*scroll-margin-top:\s*calc\(76px \+ env\(safe-area-inset-top,\s*0px\)\);/);
    });
  });

  describe('5. CLS 防抖动', () => {
    test('html 根选择器配置 scrollbar-gutter: stable 消除居中跳动', () => {
      expect(css).toMatch(/html\s*\{[^}]*scrollbar-gutter:\s*stable;/);
    });
  });

  describe('6. 固定侧栏可达性', () => {
    test('桌面端固定侧栏 .navigation 配置 overflow-y: auto 与 overscroll-behavior: contain', () => {
      expect(css).toMatch(/\.navigation\s*\{[^}]*overflow-y:\s*auto;/);
      expect(css).toMatch(/\.navigation\s*\{[^}]*overscroll-behavior:\s*contain;/);
    });
  });

  describe('7. 控件对比度提升', () => {
    test('--control-border 提升至 >= 3:1 且告警 post-notice 着色为 var(--error)', () => {
      // 浅色模式提升为 #94a3b8
      expect(css).toMatch(/:root\s*\{[^}]*--control-border:\s*#94a3b8;/);
      // 暗色模式提升为 #6b6e7b
      expect(css).toMatch(/\[data-theme=["']dark["']\]\s*\{[^}]*--control-border:\s*#6b6e7b;/);
      // post-notice[role="alert"] 显式着色为 var(--error)
      expect(css).toMatch(/\.post-notice\[role=["']alert["']\][^}]*\{[^}]*color:\s*var\(--error\);/);
    });
  });

  describe('8. 全局高对比度焦点环', () => {
    test(':focus-visible 扩大为全局高对比度焦点外框', () => {
      expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\);/);
      expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px;/);
    });
  });

  describe('9. Skip-Link 无障碍跳过链接', () => {
    test('DOM 结构：Layout 顶部包含 skip-link 且 main 包含 id="content" tabIndex={-1}', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            BookmarkProvider,
            null,
            React.createElement(PageSessionProvider, null, React.createElement(Layout))
          )
        )
      );

      expect(html).toContain('class="skip-link"');
      expect(html).toContain('href="#content"');
      expect(html).toContain('跳到主要内容');
      expect(html).toContain('id="content"');
      expect(html).toContain('tabindex="-1"');
    });

    test('CSS 样式：.skip-link 默认移出可视区，获焦时滑入置顶', () => {
      expect(css).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute;/);
      expect(css).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY\(-100%\);/);
      expect(css).toMatch(/\.skip-link:(focus|focus-visible)\s*\{[^}]*transform:\s*translateY\(0\);/);
    });
  });

  describe('10. 触控热区外扩与细滚动条', () => {
    test('搜索历史与查看详情通过 ::after 外扩触控热区至至少 44px', () => {
      expect(css).toMatch(/\.search-history\s+(li\s+button|button)::after\s*\{[^}]*min-width:\s*44px;\s*min-height:\s*44px;/);
      expect(css).toMatch(/\.detail-entry::after\s*\{[^}]*min-width:\s*44px;\s*min-height:\s*44px;/);
    });

    test('标签池与搜索历史应用 scrollbar-width: thin', () => {
      expect(css).toMatch(/\.post-tags\s*\{[^}]*scrollbar-width:\s*thin;/);
      expect(css).toMatch(/\.search-history\s+ul\s*\{[^}]*scrollbar-width:\s*thin;/);
    });
  });

  describe('11. 字体栈与抗锯齿平滑', () => {
    test('包含中文回退字体栈及全局字体平滑', () => {
      expect(css).toMatch(/font-family:[^;]*PingFang SC[^;]*Microsoft YaHei/);
      expect(css).toMatch(/-webkit-font-smoothing:\s*antialiased;/);
      expect(css).toMatch(/-moz-osx-font-smoothing:\s*grayscale;/);
    });

    test('.navigation 与 .detail-header 提升为独立 GPU 合成层', () => {
      expect(css).toMatch(/\.navigation\s*\{[^}]*transform:\s*translateZ\(0\);/);
      expect(css).toMatch(/\.detail-header\s*\{[^}]*transform:\s*translateZ\(0\);/);
    });
  });
});
