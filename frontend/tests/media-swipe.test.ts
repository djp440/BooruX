import { describe, expect, test } from 'bun:test';
import { swipeAxis, swipeTarget } from '../src/media-swipe';

describe('swipeAxis', () => {
  test('位移不足时暂不判定', () => {
    expect(swipeAxis(4, 3)).toBeNull();
  });

  test('明显横向才算横滑，斜向与纵向交给页面', () => {
    expect(swipeAxis(-20, 5)).toBe('x');
    expect(swipeAxis(12, -11)).toBe('y');
    expect(swipeAxis(3, -20)).toBe('y');
  });
});

describe('swipeTarget', () => {
  test('位移不足且速度慢时回到当前项', () => {
    expect(swipeTarget(1, 3, -30, -0.1, 300)).toBe(1);
  });

  test('向左划过阈值翻到下一项，向右翻到上一项', () => {
    expect(swipeTarget(1, 3, -80, 0, 300)).toBe(2);
    expect(swipeTarget(1, 3, 80, 0, 300)).toBe(0);
  });

  test('快速轻扫即使位移短也翻页', () => {
    expect(swipeTarget(0, 3, -20, -0.6, 300)).toBe(1);
  });

  test('首尾不越界', () => {
    expect(swipeTarget(0, 3, 200, 1, 300)).toBe(0);
    expect(swipeTarget(2, 3, -200, -1, 300)).toBe(2);
  });
});
