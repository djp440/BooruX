import { BrowserRouter, NavLink, Outlet, Route, Routes } from 'react-router';
import PostFeed from './PostFeed';
import { BookmarkProvider } from './Bookmarks';

function Layout() {
  return (
    <div className="app-shell">
      <nav className="navigation" aria-label="主导航">
        <NavLink to="/" end>首页</NavLink>
        <NavLink to="/favorites">收藏</NavLink>
        <NavLink to="/settings">设置</NavLink>
      </nav>
      <main id="content" className="content">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <BookmarkProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<PostFeed key="home" kind="home" />} />
            <Route path="favorites" element={<PostFeed key="favorites" kind="favorites" />} />
            <Route path="settings" element={<h1>设置</h1>} />
            <Route path="*" element={<h1>页面不存在</h1>} />
          </Route>
        </Routes>
      </BookmarkProvider>
    </BrowserRouter>
  );
}
