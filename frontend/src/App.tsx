import { NavLink, Route, Routes } from "react-router";

const navItems = [
  { to: "/", label: "时间线", icon: "home" },
  { to: "/search", label: "搜索", icon: "search" },
  { to: "/bookmarks", label: "收藏", icon: "bookmark" },
  { to: "/assistant", label: "AI 助手", icon: "spark" },
  { to: "/settings", label: "设置", icon: "settings" },
] as const;

function Icon({ name }: { name: (typeof navItems)[number]["icon"] }) {
  const paths = {
    home: <path d="M3 10.8 12 3l9 7.8V21h-6v-6H9v6H3z" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
    spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  } satisfies Record<(typeof navItems)[number]["icon"], React.ReactNode>;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? "mobile-nav" : "primary-nav"} aria-label="主导航">
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function Shell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="brand">
        <NavLink to="/" aria-label="BooruX 首页"><span className="brand-mark">B</span><span>BooruX</span></NavLink>
      </header>
      <aside className="left-rail">
        <Navigation />
        <p className="rail-note">浏览作品，不伪装社交功能。</p>
      </aside>
      <main id="main-content" className="main-column" tabIndex={-1}>
        <div className="page-heading">
          <p className="eyebrow">Web MVP</p>
          <h1>时间线</h1>
        </div>
        <section className="empty-panel" aria-labelledby="empty-title">
          <h2 id="empty-title">准备开始浏览</h2>
          <p>连接现有 BooruX 后端后，作品、搜索与收藏会在这里呈现。</p>
        </section>
      </main>
      <aside className="right-rail" aria-label="探索">
        <section className="side-panel">
          <h2>下一步</h2>
          <p>先从设置中选择 Profile 与内容分级，再开启你的时间线。</p>
          <NavLink className="text-link" to="/settings">打开设置</NavLink>
        </section>
      </aside>
      <Navigation mobile />
    </div>
  );
}

function Placeholder({ title, description }: { title: string; description: string }) {
  return <main id="main-content" className="main-column"><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{title}</h1></div><section className="empty-panel"><p>{description}</p></section></main>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/search" element={<Placeholder title="搜索" description="搜索功能将在下一阶段接入。" />} />
      <Route path="/bookmarks" element={<Placeholder title="收藏" description="收藏功能将在后续阶段接入。" />} />
      <Route path="/assistant" element={<Placeholder title="AI 助手" description="AI 助手将在后续阶段接入。" />} />
      <Route path="/settings" element={<Placeholder title="设置" description="设置功能将在后续阶段接入。" />} />
      <Route path="*" element={<Placeholder title="页面不存在" description="这个地址没有对应的页面。" />} />
    </Routes>
  );
}
