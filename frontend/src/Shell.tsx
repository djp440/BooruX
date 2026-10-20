import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import type { Messages } from "./i18n";
import { searchPath, searchQuery } from "./search";

const navItems = [
  { to: "/", key: "timeline", icon: "home" }, { to: "/search", key: "search", icon: "search" },
  { to: "/bookmarks", key: "bookmarks", icon: "bookmark" }, { to: "/assistant", key: "assistant", icon: "spark" },
  { to: "/settings", key: "settings", icon: "settings" },
] as const;
type IconName = (typeof navItems)[number]["icon"];

function Icon({ name }: { name: IconName }) {
  const paths = {
    home: <path d="M3 10.8 12 3l9 7.8V21h-6v-6H9v6H3z" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
    spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  } satisfies Record<IconName, ReactNode>;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Navigation({ mobile = false, t }: { mobile?: boolean; t: Messages }) {
  return <nav className={mobile ? "mobile-nav" : "primary-nav"} aria-label={t.navLabel}>{navItems.map((item) => <NavLink key={item.to} to={item.to} end={item.to === "/"}><Icon name={item.icon} /><span>{t[item.key]}</span></NavLink>)}</nav>;
}

function SearchForm({ t }: { t: Messages }) {
  const location = useLocation();
  const navigate = useNavigate();
  const query = searchQuery(location.search);
  return <form className="header-search" role="search" onSubmit={(event) => {
    event.preventDefault();
    const tags = String(new FormData(event.currentTarget).get("tags") ?? "").trim();
    navigate(tags ? searchPath(tags) : "/search");
  }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg>
    <input key={query} name="tags" type="search" defaultValue={query} aria-label={t.searchLabel} placeholder={t.searchPlaceholder} autoComplete="off" />
  </form>;
}

export function Shell({ t, children }: { t: Messages; children?: ReactNode }) {
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t.skip}</a>
    <header className="brand"><NavLink to="/" aria-label="BooruX"><span className="brand-mark">B</span><span>BooruX</span></NavLink></header>
    <div className="top-search"><SearchForm t={t} /></div>
    <aside className="left-rail"><Navigation t={t} /><p className="rail-note">{t.railNote}</p></aside>
    <main id="main-content" className="main-column" tabIndex={-1}>{children ?? <><div className="page-heading"><p className="eyebrow">{t.eyebrow}</p><h1>{t.timeline}</h1></div><section className="empty-panel"><h2>{t.ready}</h2><p>{t.readyBody}</p></section></>}</main>
    <aside className="right-rail" aria-label={t.explore}><section className="side-panel"><h2>{t.next}</h2><p>{t.nextBody}</p><NavLink className="text-link" to="/settings">{t.openSettings}</NavLink></section></aside>
    <Navigation mobile t={t} />
  </div>;
}
