import { describe, expect, spyOn, test } from 'bun:test';
import { fetchPosts, groupPosts, originalMediaURL, postSource, setPostBookmark, uniquePosts } from '../src/feed';
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

  test('GIF 与视频也保留原文件地址', () => {
    expect(originalMediaURL({ ...post('danbooru-1'), imageUrl: '/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Foriginal%2Fa.gif' })).toContain('a.gif');
    expect(originalMediaURL({ ...post('danbooru-1'), mediaType: 'video', imageUrl: 'https://cdn.donmai.us/original/a.webm' })).toContain('a.webm');
  });
});
