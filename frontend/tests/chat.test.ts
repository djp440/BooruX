import { describe, expect, test } from 'bun:test';
import { applyEvent, parseSSE, resultPosts, toolSummary } from '../src/chat-api';
import type { ChatState, ToolCall } from '../src/chat-api';

const empty = (): ChatState => ({
  conversation: { id: 'c', title: '', createdAt: '', updatedAt: '' },
  messages: [], runs: [{ id: 'r', status: 'running' }], calls: {}, cursor: 0,
});

describe('parseSSE', () => {
  test('跨分片拼接帧，忽略注释与心跳', () => {
    const frames: string[] = [];
    const parser = parseSSE(frame => frames.push(frame));
    parser.push(': keepalive\n\ndata: {"a"');
    parser.push(':1}\n\ndata: x\r\ndata: y\n\n');
    expect(frames).toEqual(['{"a":1}', 'x\ny']);
  });
});

describe('applyEvent', () => {
  test('增量按 messageId 合并，推理与正文分块', () => {
    let state = empty();
    state = applyEvent(state, { id: 1, runId: 'r', type: 'reasoning_delta', data: { messageId: 5, text: '想', key: '' } });
    state = applyEvent(state, { id: 2, runId: 'r', type: 'reasoning_delta', data: { messageId: 5, text: '一想', key: '' } });
    state = applyEvent(state, { id: 3, runId: 'r', type: 'text_delta', data: { messageId: 5, text: '你好', key: '' } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].blocks).toEqual([{ type: 'reasoning', text: '想一想', key: '' }, { type: 'text', text: '你好', key: '' }]);
    expect(state.cursor).toBe(3);
  });

  test('重放的旧事件被忽略', () => {
    let state = applyEvent(empty(), { id: 4, runId: 'r', type: 'text_delta', data: { messageId: 1, text: 'a' } });
    state = applyEvent(state, { id: 4, runId: 'r', type: 'text_delta', data: { messageId: 1, text: 'a' } });
    expect(state.messages[0].blocks[0].text).toBe('a');
  });

  test('工具状态从进行中到完成，任务结束与失败更新 run', () => {
    let state = applyEvent(empty(), { id: 1, runId: 'r', type: 'tool_started', data: { callId: 'x', name: 'search_posts', arguments: '{"tags":"cat"}' } });
    expect(state.calls.x.status).toBe('running');
    state = applyEvent(state, { id: 2, runId: 'r', type: 'tool_finished', data: { callId: 'x', name: 'search_posts', status: 'completed', result: { posts: [] } } });
    expect(state.calls.x).toMatchObject({ status: 'completed', arguments: '{"tags":"cat"}', result: { posts: [] } });
    state = applyEvent(state, { id: 3, runId: 'r', type: 'run_failed', data: { status: 'cancelled', error: '已停止' } });
    expect(state.runs[0]).toMatchObject({ status: 'cancelled', error: '已停止' });
  });

  test('message_completed 替换流式中的同一条消息', () => {
    let state = applyEvent(empty(), { id: 1, runId: 'r', type: 'text_delta', data: { messageId: 9, text: '半' } });
    state = applyEvent(state, { id: 2, runId: 'r', type: 'message_completed', data: { messageId: 9, message: { role: 'assistant', content: '完整', blocks: [{ type: 'text', text: '完整' }] } } });
    expect(state.messages).toEqual([{ id: 9, runId: 'r', status: 'completed', role: 'assistant', content: '完整', blocks: [{ type: 'text', text: '完整' }] }]);
  });
});

describe('工具展示', () => {
  const call = (name: string, args: unknown, result?: Record<string, unknown>): ToolCall => ({ callId: '1', name, arguments: JSON.stringify(args), status: 'completed', result });

  test('toolSummary 生成可读标题', () => {
    expect(toolSummary(call('search_posts', { tags: 'cat' }, { posts: [{}, {}] }))).toBe('搜索作品 · cat · 2 个结果');
    expect(toolSummary(call('search_tags', { query: 'sky' }, { tags: ['a'] }))).toBe('查询标签 · sky · 1 个标签');
    expect(toolSummary(call('set_bookmark', { id: 'danbooru-1', bookmarked: false }))).toBe('取消收藏 danbooru-1');
    expect(toolSummary({ ...call('list_bookmarks', {}), arguments: '坏 JSON' })).toBe('查看收藏');
  });

  test('resultPosts 兼容列表与单个作品', () => {
    expect(resultPosts(call('get_post', {}, { post: { id: 'p1', tags: ['cat'], previewUrl: '/p' } }))[0]).toMatchObject({ id: 'p1', previewUrl: '/p', tags: [{ name: 'cat' }] });
    expect(resultPosts(call('search_posts', {}, { error: '失败' }))).toEqual([]);
  });
});
