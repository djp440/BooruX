import { useEffect } from 'react';
import type { RefObject } from 'react';

// 横滑超过轨道单项宽度的这一比例，或松手速度超过阈值（px/ms），即翻到相邻项。
const DISTANCE_RATIO = 0.18;
const FLICK_VELOCITY = 0.35;
// 位移超过该值才判定方向；横向需明显大于纵向才算横滑，斜向手势一律交给页面滚动。
const AXIS_SLOP = 8;
const HORIZONTAL_BIAS = 1.2;

export function swipeTarget(current: number, count: number, dx: number, velocity: number, width: number): number {
  let target = current;
  if (Math.abs(dx) > width * DISTANCE_RATIO || Math.abs(velocity) > FLICK_VELOCITY) {
    const direction = Math.abs(dx) > 0 ? Math.sign(dx) : Math.sign(velocity);
    target = current - direction;
  }
  return Math.max(0, Math.min(count - 1, target));
}

// 手势起步时锁定方向：未达阈值返回 null，之后整个手势保持该方向。
export function swipeAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < AXIS_SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS ? 'x' : 'y';
}

/**
 * 触屏横滑翻媒体。触屏上轨道不可原生横滚（见 style.css），这里用 touch 事件锁定方向：
 * 纵向手势完全不干预，由页面原生滚动；横向手势阻止默认行为并跟手、松手吸附。
 * 使用 touch 而非 pointer 事件，是因为 iOS Safari 不可靠地遵守 touch-action，只有非 passive 的 touchmove 能稳定拦截。
 */
export function useMediaSwipe(ref: RefObject<HTMLElement | null>, count: number) {
  useEffect(() => {
    const track = ref.current;
    if (!track || count < 2) return;
    let gesture: { x: number; y: number; left: number; index: number; step: number; axis: 'x' | 'y' | null; lastX: number; lastT: number; velocity: number } | null = null;
    let suppressClick = false;
    let frame = 0;

    const items = () => Array.from(track.children) as HTMLElement[];
    // 与 CSS 的 scroll-snap-align: center 一致：让第 index 项居中，首尾受滚动范围限制。
    const offsetOf = (index: number) => {
      const item = items()[index];
      if (!item) return track.scrollLeft;
      const box = track.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      const left = track.scrollLeft + rect.left - box.left - track.clientLeft - (track.clientWidth - rect.width) / 2;
      return Math.max(0, Math.min(track.scrollWidth - track.clientWidth, left));
    };
    const nearestIndex = () => {
      let best = 0;
      for (let i = 1; i < count; i++) if (Math.abs(offsetOf(i) - track.scrollLeft) < Math.abs(offsetOf(best) - track.scrollLeft)) best = i;
      return best;
    };
    // 自绘缓动吸附：动画期间保持 data-dragging（关闭 CSS 吸附），避免吸附与平滑滚动互相拉扯造成抽搐。
    const settle = (index: number) => {
      cancelAnimationFrame(frame);
      const from = track.scrollLeft;
      const to = offsetOf(index);
      const begin = performance.now();
      const duration = Math.min(320, 160 + Math.abs(to - from) * 0.6);
      const step = (now: number) => {
        const t = Math.min(1, (now - begin) / duration);
        track.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3);
        if (t < 1) frame = requestAnimationFrame(step);
        else delete track.dataset.dragging;
      };
      frame = requestAnimationFrame(step);
    };
    const finish = (dx: number, commit: boolean) => {
      if (!gesture) return;
      const { axis, index, step, velocity } = gesture;
      gesture = null;
      if (axis !== 'x') {
        // 打断了吸附动画却没有横滑：把动画补完。
        if ('dragging' in track.dataset) settle(index);
        return;
      }
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
      settle(commit ? swipeTarget(index, count, dx, velocity, step) : index);
    };

    const start = (event: TouchEvent) => {
      // 多指（缩放）或从视频控件开始的手势不接管。
      if (event.touches.length !== 1 || (event.target as Element | null)?.closest?.('video')) {
        finish(0, false);
        return;
      }
      // 吸附动画中再次按下，从当前位置接手。
      cancelAnimationFrame(frame);
      const touch = event.touches[0];
      gesture = { x: touch.clientX, y: touch.clientY, left: track.scrollLeft, index: nearestIndex(), step: items()[0]?.offsetWidth || track.clientWidth, axis: null, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0 };
    };
    const move = (event: TouchEvent) => {
      if (!gesture || gesture.axis === 'y') return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x;
      if (!gesture.axis) {
        gesture.axis = swipeAxis(dx, touch.clientY - gesture.y);
        if (gesture.axis !== 'x') return;
        track.dataset.dragging = '';
      }
      if (event.cancelable) event.preventDefault();
      const dt = event.timeStamp - gesture.lastT;
      if (dt > 0) gesture.velocity = (touch.clientX - gesture.lastX) / dt;
      gesture.lastX = touch.clientX;
      gesture.lastT = event.timeStamp;
      track.scrollLeft = gesture.left - dx;
    };
    const end = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.changedTouches[0];
      finish(touch ? touch.clientX - gesture.x : 0, true);
    };
    const cancel = () => finish(0, false);
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    track.addEventListener('touchstart', start, { passive: true });
    track.addEventListener('touchmove', move, { passive: false });
    track.addEventListener('touchend', end);
    track.addEventListener('touchcancel', cancel);
    track.addEventListener('click', click, true);
    return () => {
      track.removeEventListener('touchstart', start);
      track.removeEventListener('touchmove', move);
      track.removeEventListener('touchend', end);
      track.removeEventListener('touchcancel', cancel);
      track.removeEventListener('click', click, true);
      cancelAnimationFrame(frame);
      delete track.dataset.dragging;
    };
  }, [ref, count]);
}
