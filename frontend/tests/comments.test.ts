import { describe, expect, spyOn, test } from 'bun:test';
import { commentKey, commentTextParts, commentsComplete, commentsNeedReload, compareComments, createComments, fetchCommentPage, loadComments } from '../src/comments';
import type { Comment, CommentPage } from '../src/comments';
import type { Post } from '../src/feed';

const posts = (ids: string[]) => ids.map(id => ({ id } as Post));
const comment = (postId: string, id: string, day: number): Comment => ({ postId, id, source: 'danbooru', createdAt: `2025-01-${String(day).padStart(2, '0')}T00:00:00.000000000Z`, author: '作者', body: 'text', sourceUrl: 'https://example.org' });
const page = (memberId: string, comments: Comment[], nextCursor: string | null = null): CommentPage => ({ success: true, availability: 'available', memberId, comments, nextCursor, exhausted: nextCursor === null });

describe('整组原站评论', () => {
  test('先补齐流头部，下一来源页仍比其他成员当前候选更新', async () => {
    const requested: string[] = [];
    const result = await loadComments(createComments(posts(['a', 'b'])), async (member, cursor) => {
      requested.push(`${member}:${cursor}`);
      if (member === 'b') return page('b', [comment('b', '1', 10)]);
      return cursor ? page('a', [comment('a', '2', 20)]) : page('a', [comment('a', '1', 30)], 'next');
    }, false, 3);
    expect(result.displayed.map(item => `${item.postId}:${item.id}`)).toEqual(['a:1', 'a:2', 'b:1']);
    expect(requested).toContain('a:next');
    expect(commentsComplete(result)).toBe(true);
  });
  test('跨 UI 页和来源页去重、同时间固定顺序、大整数 ID 不转换', async () => {
    let state = createComments(posts(['a', 'b']));
    const request = async (member: string, cursor: string | null) => member === 'b'
      ? page('b', [comment('b', '9007199254740993', 10)])
      : cursor ? page('a', [comment('a', '2', 10), comment('a', '3', 9)]) : page('a', [comment('a', '1', 10), comment('a', '2', 10)], 'p2');
    state = await loadComments(state, request, false, 2);
    expect(state.displayed.map(item => item.id)).toEqual(['1', '2']);
    state = await loadComments(state, request, false, 10);
    expect(state.displayed.map(item => item.id)).toEqual(['1', '2', '9007199254740993', '3']);
    expect(new Set(state.displayed.map(commentKey)).size).toBe(4);
    expect(commentsComplete(state)).toBe(true);
  });
  test('部分失败保留成功结果，重试补回更新评论后重新排序', async () => {
    let state = await loadComments(createComments(posts(['a', 'b'])), async member => {
      if (member === 'a') throw new Error('HTTP 503');
      return page('b', [comment('b', '1', 10)]);
    });
    expect(state.displayed.map(item => item.postId)).toEqual(['b']);
    expect(state.streams[0].error).toBe('HTTP 503');
    expect(commentsComplete(state)).toBe(false);
    const requested: string[] = [];
    state = await loadComments(state, async member => { requested.push(member); return page(member, [comment(member, '1', 20)]); }, true);
    expect(requested).toEqual(['a']);
    expect(state.displayed.map(item => item.postId)).toEqual(['a', 'b']);
    expect(commentsComplete(state)).toBe(true);
  });
  test('分页后409重建整组，502和网络错误保留游标恢复', async () => {
    for (const failure of [409, 502, 'network'] as const) {
      const members = posts(['a', 'b']);
      const requested: string[] = [];
      let phase = 'initial';
      const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        const member = url.searchParams.get('memberId')!;
        const cursor = url.searchParams.get('cursor');
        requested.push(`${member}:${cursor}`);
        if (phase === 'failure') {
          if (failure === 'network') throw new TypeError('Failed to fetch');
          return Response.json({ success: false, error: failure === 409 ? '评论已变化，请重新加载评论' : 'upstream failed' }, { status: failure });
        }
        if (phase === 'recovery' && failure === 409) return Response.json(page(member, [comment(member, 'fresh', 25)]));
        return Response.json(member === 'b' ? page(member, [comment(member, 'old-b', 1)])
          : cursor ? page(member, [comment(member, 'tail', 10)]) : page(member, [comment(member, 'old-a', 30)], 'deleted-anchor'));
      }) as unknown as typeof fetch);
      try {
        const request = (member: string, cursor: string | null) => fetchCommentPage('a', member, cursor, new AbortController().signal);
        let state = await loadComments(createComments(members), request, false, 1);
        expect(state.displayed.map(item => item.id)).toEqual(['old-a']);
        expect(state.streams[1].buffer.map(item => item.id)).toEqual(['old-b']);
        phase = 'failure';
        state = await loadComments(state, request);
        expect(state.streams[0].nextCursor).toBe('deleted-anchor');
        expect(state.streams[0].error).not.toBe('');
        expect(commentsNeedReload(state)).toBe(failure === 409);
        expect(commentsComplete(state)).toBe(false);
        expect(state.displayed.map(item => item.id)).toEqual(['old-a', 'old-b']);
        phase = 'recovery'; requested.length = 0;
        if (commentsNeedReload(state)) {
          state = createComments(members);
          expect(state.displayed).toEqual([]);
          expect(state.streams.every(stream => !stream.buffer.length && !stream.seen.size && stream.nextCursor === null && !stream.exhausted && !stream.error && !stream.reloadRequired)).toBe(true);
        }
        state = await loadComments(state, request, true);
        expect(requested).toEqual(failure === 409 ? ['a:null', 'b:null'] : ['a:deleted-anchor']);
        expect(state.displayed.map(item => item.id)).toEqual(failure === 409 ? ['fresh', 'fresh'] : ['old-a', 'tail', 'old-b']);
        expect(new Set(state.displayed.map(commentKey)).size).toBe(state.displayed.length);
        expect(commentsComplete(state)).toBe(true);
        expect(commentsNeedReload(state)).toBe(false);
      } finally { fetchMock.mockRestore(); }
    }
  });
  test('全空和全部失败状态不同，不把错误当完成', async () => {
    const empty = await loadComments(createComments(posts(['a', 'b'])), async member => page(member, []));
    expect(empty.displayed).toEqual([]); expect(commentsComplete(empty)).toBe(true);
    const failed = await loadComments(createComments(posts(['a', 'b'])), async () => { throw new Error('offline'); });
    expect(failed.displayed).toEqual([]); expect(commentsComplete(failed)).toBe(false);
    expect(failed.streams.every(stream => stream.error && !stream.exhausted)).toBe(true);
  });
  test('空缓冲继续补页，无进展和无限重复都留下可重试错误', async () => {
    const state = await loadComments(createComments(posts(['a'])), async (member, cursor) => cursor ? page(member, [comment(member, '1', 1)]) : page(member, [], 'next'));
    expect(state.displayed.length).toBe(1);
    const stalled = await loadComments(createComments(posts(['a'])), async member => ({ ...page(member, []), exhausted: false }));
    expect(stalled.streams[0].error).toContain('未前进');
    let calls = 0;
    const repeats = await loadComments(createComments(posts(['a'])), async member => page(member, [comment(member, '1', 1)], String(++calls)), false, 2);
    expect(repeats.streams[0].error).toContain('达到限制');
    expect(commentsComplete(repeats)).toBe(false);
  });
  test('只生成 HTTP(S) 链接，HTML、脚本协议与换行保留为文本', () => {
    const body = '<img src=x onerror=alert(1)>\njavascript:alert(1) https://example.org/a?q=1\nhttps://example.net';
    const parts = commentTextParts(body);
    expect(parts.map(part => part.text).join('')).toBe(body);
    expect(parts.filter(part => part.href).map(part => part.href)).toEqual(['https://example.org/a?q=1', 'https://example.net/']);
    expect(commentKey(comment('a', 'b:c', 1))).not.toBe(commentKey(comment('a:b', 'c', 1)));
    expect(compareComments(comment('a', '1', 2), comment('a', '2', 1))).toBeLessThan(0);
  });
});
