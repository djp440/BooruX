import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router';
import PostFeed from './PostFeed';
import PostDetail from './PostDetail';
import Settings from './Settings';
import { BookmarkProvider, useBookmarks } from './Bookmarks';
import { areaForPath, PageSessionProvider, usePageSession } from './page-session';
import { Icon } from './icons';

// 收藏成功的短暂提示，出现在操作附近的视口底部；失败仍在卡片内以 alert 呈现。
function BookmarkToast() {
  const { action } = useBookmarks();
  const [toast, setToast] = useState<{ key: number; message: string } | null>(null);
  useEffect(() => {
    if (action && !action.error) setToast(current => ({ key: (current?.key ?? 0) + 1, message: action.message }));
  }, [action]);
  return <div className="toast-region" role="status" aria-live="polite">
    {toast && <p className="toast" key={toast.key}>{toast.message}</p>}
  </div>;
}

export function Layout() {
  const { pathname } = useLocation();
  const { store, save, goArea } = usePageSession();
  const settingsActive = pathname === '/settings';
  return (
    <div className="app-shell">
      <a href="#content" className="skip-link">跳到主要内容</a>
      <nav className="navigation" aria-label="主导航">
        <div className="brand"><span className="brand-mark" aria-hidden="true">B</span>BooruX</div>
        {(['home', 'favorites'] as const).map(area => {
          const active = !settingsActive && areaForPath(pathname) === area;
          return <Link key={area} to={store.lastVisit[area]?.path || (area === 'home' ? '/' : '/favorites')} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}
            onClick={event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); goArea(area); } }}>
            <Icon name={area === 'home' ? 'home' : 'bookmark'} /><span>{area === 'home' ? '首页' : '收藏'}</span>
          </Link>;
        })}
        <Link to="/settings" className={settingsActive ? 'active' : ''} aria-current={settingsActive ? 'page' : undefined} onClick={save}>
          <Icon name="settings" /><span>设置</span>
        </Link>
      </nav>
      <main id="content" className="content" tabIndex={-1}><Outlet /></main>
      <BookmarkToast />
    </div>
  );
}
function FeedRoute({ kind }: { kind: 'home' | 'favorites' }) {
  const { page } = usePageSession();
  return <PostFeed key={page.id} kind={kind} />;
}
function DetailRoute() {
  const { page } = usePageSession();
  return <PostDetail key={page.id} />;
}
function NotFound() {
  return <section className="feed" aria-label="页面不存在">
    <header className="page-header"><h1>页面不存在</h1></header>
    <div className="empty-state">
      <p className="empty-title">找不到这个页面</p>
      <p className="empty-desc">链接可能已失效，或地址输入有误。</p>
      <Link className="button primary" to="/">回到首页</Link>
    </div>
  </section>;
}
export default function App() {
  return <BrowserRouter><BookmarkProvider><PageSessionProvider>
    <Routes><Route element={<Layout />}>
      <Route index element={<FeedRoute kind="home" />} />
      <Route path="posts/:id" element={<DetailRoute />} />
      <Route path="favorites" element={<FeedRoute kind="favorites" />} />
      <Route path="favorites/posts/:id" element={<DetailRoute />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<NotFound />} />
    </Route></Routes>
  </PageSessionProvider></BookmarkProvider></BrowserRouter>;
}
