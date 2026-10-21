import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router';
import PostFeed from './PostFeed';
import PostDetail from './PostDetail';
import Settings from './Settings';
import { BookmarkProvider } from './Bookmarks';
import { areaForPath, PageSessionProvider, usePageSession } from './page-session';

export function Layout() {
  const { pathname } = useLocation();
  const { store, save, goArea } = usePageSession();
  return (
    <div className="app-shell">
      <a href="#content" className="skip-link">跳到主要内容</a>
      <nav className="navigation" aria-label="主导航">
        {(['home', 'favorites'] as const).map(area => {
          const active = pathname !== '/settings' && areaForPath(pathname) === area;
          return <Link key={area} to={store.lastVisit[area]?.path || (area === 'home' ? '/' : '/favorites')} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}
            onClick={event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); goArea(area); } }}>{area === 'home' ? '首页' : '收藏'}</Link>;
        })}
        <Link to="/settings" className={pathname === '/settings' ? 'active' : ''} aria-current={pathname === '/settings' ? 'page' : undefined} onClick={save}>设置</Link>
      </nav>
      <main id="content" className="content" tabIndex={-1}><Outlet /></main>
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
export default function App() {
  return <BrowserRouter><BookmarkProvider><PageSessionProvider>
    <Routes><Route element={<Layout />}>
      <Route index element={<FeedRoute kind="home" />} />
      <Route path="posts/:id" element={<DetailRoute />} />
      <Route path="favorites" element={<FeedRoute kind="favorites" />} />
      <Route path="favorites/posts/:id" element={<DetailRoute />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<h1>页面不存在</h1>} />
    </Route></Routes>
  </PageSessionProvider></BookmarkProvider></BrowserRouter>;
}
