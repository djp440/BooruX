import { describe, expect, spyOn, test } from 'bun:test';
import { fetchPosts, groupPosts, originalMediaURL, postSource, relativeTime, setPostBookmark, uniquePosts } from '../src/feed';
import type { Post } from '../src/feed';

function post(id: string, parentId: string | null = null): Post {
  return { id, parentId, title: id, imageUrl: 'https://cdn.donmai.us/original/a.png', mediaType: 'image', hasChildren: false, tags: [] };
}

describe('帖子流', () => {
  test('父子帖合并，跨页重复成员只出现一次，收藏的其他来源也能分组', () => {
    const posts = [post('danbooru-2', 'danbooru-1'), post('danbooru-3'), post('danbooru-1'), post('danbooru-2', 'danbooru-1'), post('safebooru-4')];
    expect(groupPosts(posts).map(group => [group.id, group.posts.map(item => item.id)])).toEqual([
      ['danbooru-1', ['danbooru-2', 'danbooru-1']],
      ['danbooru-3', ['danbooru-3']],
      ['safebooru-4', ['safebooru-4']],
    ]);
  });

  test('最新媒体元数据覆盖旧值，但保留原来的顺序', () => {
    const first = post('danbooru-1');
    const updated = { ...first, imageUrl: 'https://cdn.donmai.us/original/b.png' };
    expect(uniquePosts([first, post('danbooru-2'), updated])).toEqual([updated, post('danbooru-2')]);
  });

  test('使用原图而非已转换的缓存，不将缩略图和样本冒充原图', () => {
    const item = post('danbooru-1');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media/cache/danbooru-1', originalUrl: item.imageUrl })).toBe(item.imageUrl);
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Fsample%2Fa.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'https://cdn.donmai.us/180x180/a.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'javascript:alert(1)' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'http://[' })).toBe('');
  });

  test('收藏接口归一化为同一种帖子列表，缓存不会重复存储 bookmarks', async () => {
    const posts = [post('danbooru-1')];
    const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, bookmarks: posts })));
    try {
      const result = await fetchPosts('/api/profiles/default/bookmarks', new AbortController().signal, 'bookmarks');
      expect(result.posts).toEqual(posts);
      expect(result).not.toHaveProperty('bookmarks');
      request.mockResolvedValue(new Response(JSON.stringify({ success: true, posts })));
      await expect(fetchPosts('/api/profiles/default/bookmarks', new AbortController().signal, 'bookmarks')).rejects.toThrow('帖子加载失败');
    } finally {
      request.mockRestore();
    }
  });

  test('收藏使用显式目标状态，取消时清除整组，服务端未确认成功则报错', async () => {
    const item = post('danbooru-1');
    const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, post: { ...item, isBookmarked: true } })));
    try {
      expect((await setPostBookmark(item.id, true)).isBookmarked).toBe(true);
      expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ bookmarked: true, family: false });
      request.mockResolvedValue(new Response(JSON.stringify({ success: true, post: { ...item, isBookmarked: false } })));
      expect((await setPostBookmark(item.id, false)).isBookmarked).toBe(false);
      expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ bookmarked: false, family: true });
      request.mockResolvedValue(new Response(JSON.stringify({ success: true, post: { ...item, isBookmarked: true } })));
      await expect(setPostBookmark(item.id, false)).rejects.toThrow('收藏操作失败');
      request.mockResolvedValue(new Response(JSON.stringify({ success: false, error: '保存失败' }), { status: 500 }));
      await expect(setPostBookmark(item.id, true)).rejects.toThrow('保存失败');
    } finally {
      request.mockRestore();
    }
  });

  test('各来源使用对应的名称和原站链接', () => {
    expect(postSource('danbooru-1')).toEqual({ label: 'Danbooru #1', href: 'https://danbooru.donmai.us/posts/1' });
    expect(postSource('safebooru-2').href).toContain('safebooru.org/index.php?page=post&s=view&id=2');
    expect(postSource('yandere-3').href).toBe('https://yande.re/post/show/3');
    expect(postSource('local-import')).toEqual({ label: 'local-import' });
  });

  test('媒体防伪正则收紧：过滤 Safebooru 样本/缩略图、Danbooru 预览与 sample_/thumbnail_ 低清图', () => {
    const item = post('danbooru-1');
    expect(originalMediaURL({ ...item, imageUrl: 'https://safebooru.org/samples/12/sample_12.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'https://safebooru.org/thumbnails/12/thumbnail_12.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=https%3A%2F%2Fsafebooru.org%2Fsamples%2F12.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=https%3A%2F%2Fsafebooru.org%2Fthumbnails%2F12.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'https://cdn.donmai.us/preview/12/34/12345.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Fpreview%2F12%2F34%2F12345.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'https://example.com/images/sample_foo.jpg' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'https://example.com/images/thumbnail_bar.png' })).toBe('');
  });

  test('协议相对路径解析与非法协议（data:, file:, javascript:）阻断', () => {
    const item = post('danbooru-1');
    expect(originalMediaURL({ ...item, imageUrl: '//cdn.donmai.us/original/a.png' })).toBe('https://cdn.donmai.us/original/a.png');
    expect(originalMediaURL({ ...item, imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: 'file:///etc/passwd' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=javascript%3Aalert(1)' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=data%3Aimage%2Fpng%3Bbase64%2C123' })).toBe('');
    expect(originalMediaURL({ ...item, imageUrl: '/api/media?url=file%3A%2F%2F%2Fetc%2Fpasswd' })).toBe('');
    // originalUrl 损坏或低清时可降级到 imageUrl
    expect(originalMediaURL({ ...item, originalUrl: 'https://safebooru.org/samples/1.jpg', imageUrl: 'https://safebooru.org/images/1.jpg' })).toBe('https://safebooru.org/images/1.jpg');
  });

  test('fetchPosts 安全捕获非 JSON 响应（502/504 HTML），包装为语义化错误附带状态码', async () => {
    const html502 = new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
    const request = spyOn(globalThis, 'fetch').mockResolvedValue(html502);
    try {
      await expect(fetchPosts('/api/danbooru/posts', new AbortController().signal)).rejects.toThrow(/服务响应异常.*502|502.*服务响应异常/);
      request.mockResolvedValue(new Response('Gateway Timeout', { status: 504, headers: { 'Content-Type': 'text/plain' } }));
      await expect(fetchPosts('/api/danbooru/posts', new AbortController().signal)).rejects.toThrow(/504/);
    } finally {
      request.mockRestore();
    }
  });

  test('GIF 与视频也保留原文件地址', () => {
    expect(originalMediaURL({ ...post('danbooru-1'), imageUrl: '/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Foriginal%2Fa.gif' })).toContain('a.gif');
    expect(originalMediaURL({ ...post('danbooru-1'), mediaType: 'video', imageUrl: 'https://cdn.donmai.us/original/a.webm' })).toContain('a.webm');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-23T12:00:00Z').getTime();
  const ago = (seconds: number) => relativeTime(new Date(now - seconds * 1000), now);

  test('七天内显示相对时间，更早显示日期，跨年带年份', () => {
    expect(ago(30)).toBe('刚刚');
    expect(ago(5 * 60)).toBe('5分钟前');
    expect(ago(3 * 3600)).toBe('3小时前');
    expect(ago(86400)).toBe('昨天');
    expect(ago(8 * 86400)).toBe('10月15日');
    expect(relativeTime(new Date('2025-03-02T12:00:00Z'), now)).toBe('2025年3月2日');
  });
});
