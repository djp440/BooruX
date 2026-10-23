import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePageSession } from './page-session';

// 覆盖层（查看器、抽屉）打开时压入一条历史记录（带 sessionId 以复用当前页面会话），
// 后退手势只关闭覆盖层；返回的 close 用于主动关闭，会回退掉这条记录。
export function useHistoryLayer(onClose: () => void): () => void {
  const { page } = usePageSession();
  const location = useLocation();
  const navigate = useNavigate();
  const pushedKey = useRef<string | null>(null);
  const closing = useRef(false);
  const [token] = useState(() => Math.random().toString(36).slice(2));

  // 延迟压栈：StrictMode 的首次挂载会被清理取消，避免重复写入历史。
  useEffect(() => {
    const timer = window.setTimeout(() => navigate(location.pathname + location.search, { state: { ...location.state, sessionId: page.id, layer: token } }));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pushedKey.current === null) {
      if (location.state?.layer === token) pushedKey.current = location.key;
    } else if (location.key !== pushedKey.current) onClose();
  }, [location.key, location.state, onClose, token]);

  return () => {
    if (closing.current) return;
    closing.current = true;
    if (pushedKey.current) navigate(-1);
    else onClose();
  };
}
