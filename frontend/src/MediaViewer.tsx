import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { originalMediaURL, postSource } from './feed';
import type { Post } from './feed';
import { useHistoryLayer } from './history-layer';
import { Icon } from './icons';

// 全屏媒体查看器：原生 <dialog> 提供焦点限制、Esc 与焦点归还；挂到 body 以避开卡片的 content-visibility。
// 打开时压入一条历史记录（带 sessionId 以复用当前页面会话），后退手势只关闭查看器。
export default function MediaViewer({ posts, start, onClose }: { posts: Post[]; start: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const zoomCenter = useRef<{ x: number; y: number } | null>(null);
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const current = posts[index];
  const src = current ? originalMediaURL(current) : '';

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    track.current!.scrollLeft = start * track.current!.clientWidth;
    closeButton.current?.focus();
    return () => element.close();
  }, [start]);

  const close = useHistoryLayer(onClose);

  useEffect(() => {
    setZoomed(false);
    track.current?.querySelectorAll('video').forEach((video, i) => { if (i !== index) video.pause(); });
  }, [index]);

  useLayoutEffect(() => {
    const slide = track.current?.children[index] as HTMLElement | undefined;
    const img = slide?.querySelector('img');
    const center = zoomCenter.current;
    if (!zoomed || !slide || !img || !center) return;
    zoomCenter.current = null;
    slide.scrollLeft = img.offsetLeft + center.x * img.offsetWidth - slide.clientWidth / 2;
    slide.scrollTop = img.offsetTop + center.y * img.offsetHeight - slide.clientHeight / 2;
  }, [zoomed, index]);

  const go = (target: number) => {
    const element = track.current;
    if (!element || target < 0 || target >= posts.length) return;
    element.scrollTo({ left: target * element.clientWidth, behavior: 'smooth' });
  };

  const toggleZoom = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (drag.current?.moved) return;
    if (zoomed) { setZoomed(false); return; }
    const img = event.currentTarget;
    if (img.naturalWidth <= img.clientWidth && img.naturalHeight <= img.clientHeight) return;
    const rect = img.getBoundingClientRect();
    zoomCenter.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    setZoomed(true);
  };

  // 鼠标拖动平移原尺寸图片；触屏与触控板直接使用原生滚动。
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (!zoomed || event.pointerType !== 'mouse' || event.button !== 0) return;
    const slide = event.currentTarget;
    drag.current = { x: event.clientX, y: event.clientY, left: slide.scrollLeft, top: slide.scrollTop, moved: false };
    slide.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (Math.hypot(dx, dy) > 5) state.moved = true;
    event.currentTarget.scrollLeft = state.left - dx;
    event.currentTarget.scrollTop = state.top - dy;
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="media-viewer"
      aria-label="媒体查看器"
      onCancel={event => { event.preventDefault(); if (zoomed) setZoomed(false); else close(); }}
      // 仅响应浏览器强制关闭（如连续 Esc）；卸载与 StrictMode 重挂载时的 close 事件忽略。
      onClose={() => { if (dialog.current && !dialog.current.open) close(); }}
      // React 合成事件会穿过 portal 冒泡到卡片，阻止以免触发“进入详情”。
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
      }}
    >
      <div className="viewer-toolbar">
        {posts.length > 1 ? <span className="viewer-count" aria-live="polite">{index + 1} / {posts.length}</span> : <span />}
        <span className="viewer-actions">
          {src && <a className="viewer-button" href={src} target="_blank" rel="noreferrer noopener" aria-label="在新标签页打开原文件" title="打开原文件"><Icon name="open" /></a>}
          <button ref={closeButton} type="button" className="viewer-button" onClick={close} aria-label="关闭查看器" title="关闭（Esc）"><Icon name="close" /></button>
        </span>
      </div>
      <div ref={track} className="viewer-track" data-locked={zoomed || undefined}
        onScroll={event => setIndex(Math.min(posts.length - 1, Math.max(0, Math.round(event.currentTarget.scrollLeft / event.currentTarget.clientWidth))))}>
        {posts.map((post, i) => {
          const url = originalMediaURL(post);
          const label = postSource(post.id).label;
          return <div key={`${post.id}:${url}`} className="viewer-slide" data-zoomed={(zoomed && i === index) || undefined}
            onClick={event => { if (event.target === event.currentTarget && !drag.current?.moved) close(); }}
            onPointerDown={startDrag} onPointerMove={moveDrag}>
            {!url ? <p className="viewer-message">未提供可访问的原始媒体</p>
              : post.mediaType === 'video' ? <video src={url} controls playsInline preload="metadata" aria-label={label} />
              : <img src={url} alt={label} decoding="async" draggable={false} onClick={toggleZoom} />}
          </div>;
        })}
      </div>
      {index > 0 && <button type="button" className="viewer-nav prev" onClick={() => go(index - 1)} aria-label="上一项" title="上一项（←）"><Icon name="prev" /></button>}
      {index < posts.length - 1 && <button type="button" className="viewer-nav next" onClick={() => go(index + 1)} aria-label="下一项" title="下一项（→）"><Icon name="next" /></button>}
    </dialog>,
    document.body,
  );
}
