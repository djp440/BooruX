import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, useParams } from "react-router";
import { getProfiles, getSettings, getTimeline, saveSettings, type Language, type Post, type Profile, type Settings } from "./api";
import { messages, type Messages } from "./i18n";

const PROFILE_KEY = "boorux.profile";
const DEFAULT_PROFILE = "default";
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
  } satisfies Record<IconName, React.ReactNode>;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Navigation({ mobile = false, t }: { mobile?: boolean; t: Messages }) {
  return <nav className={mobile ? "mobile-nav" : "primary-nav"} aria-label={t.navLabel}>{navItems.map((item) => <NavLink key={item.to} to={item.to} end={item.to === "/"}><Icon name={item.icon} /><span>{t[item.key]}</span></NavLink>)}</nav>;
}

function browserLanguage(): Language {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function Shell({ t, children }: { t: Messages; children?: React.ReactNode }) {
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t.skip}</a>
    <header className="brand"><NavLink to="/" aria-label="BooruX"><span className="brand-mark">B</span><span>BooruX</span></NavLink></header>
    <aside className="left-rail"><Navigation t={t} /><p className="rail-note">{t.railNote}</p></aside>
    <main id="main-content" className="main-column" tabIndex={-1}>{children ?? <><div className="page-heading"><p className="eyebrow">{t.eyebrow}</p><h1>{t.timeline}</h1></div><section className="empty-panel"><h2>{t.ready}</h2><p>{t.readyBody}</p></section></>}</main>
    <aside className="right-rail" aria-label={t.explore}><section className="side-panel"><h2>{t.next}</h2><p>{t.nextBody}</p><NavLink className="text-link" to="/settings">{t.openSettings}</NavLink></section></aside>
    <Navigation mobile t={t} />
  </div>;
}

function Placeholder({ t, title, description }: { t: Messages; title: string; description: string }) {
  return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{title}</h1></div><section className="empty-panel"><p>{description}</p></section></Shell>;
}

function SearchPage({ t }: { t: Messages }) {
  const tags = new URLSearchParams(useLocation().search).get("tags") ?? "";
  return <Placeholder t={t} title={t.search} description={tags ? t.searchComingSoon.replace("{tags}", tags) : t.placeholderSearch} />;
}

function relativeTime(value: string, language: Language) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return value;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

function PostCard({ post, t, language }: { post: Post; t: Messages; language: Language }) {
  const media = post.mediaType === "video" ? post.previewUrl || post.imageUrl : post.imageUrl;
  const animated = post.mediaType === "gif" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return <article className="post-card" data-post-id={post.id}>
    <header className="post-author">
      <span className="artist-mark" aria-hidden="true">{post.artist.slice(0, 1).toUpperCase()}</span>
      <span className="artist-name">{post.artist}</span>
      <time dateTime={post.createdAt}>{relativeTime(post.createdAt, language)}</time>
      {post.isBookmarked && <span className="bookmark-state" aria-label={t.bookmarked}>{t.bookmarked}</span>}
    </header>
    <h2 className="post-title">{post.title}</h2>
    {post.description && <p className="post-description">{post.description}</p>}
    <div className="post-media" style={{ aspectRatio: post.aspectRatio || post.width / post.height || .5625 }}>
      <img src={animated ? media : post.previewUrl || media} alt={post.title} loading="lazy" decoding="async" />
      {post.mediaType === "video" && <span className="media-badge">{t.video}</span>}
      {post.mediaType === "gif" && <span className="media-badge">{t.gif}</span>}
    </div>
    <div className="post-tags">{(post.tags ?? []).slice(0, 8).map((tag) => <NavLink key={tag.id} to={"/search?tags=" + encodeURIComponent(tag.name)}>#{tag.name}</NavLink>)}</div>
  </article>;
}

function TimelinePage({ t, profileId, ready }: { t: Messages; profileId: string; ready: boolean }) {
  const language: Language = t === messages["zh-CN"] ? "zh-CN" : "en";
  const query = useInfiniteQuery({
    queryKey: ["timeline", profileId],
    queryFn: ({ pageParam }) => getTimeline(profileId, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled: ready,
  });
  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  const first = query.data?.pages[0];
  useEffect(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    const sentinel = document.querySelector(".load-more");
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) query.fetchNextPage();
    }, { rootMargin: "500px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);
  return <Shell t={t}>
    <div className="page-heading timeline-heading"><div><p className="eyebrow">{t.eyebrow}</p><h1>{t.timeline}</h1></div>{first && <span className={"source-pill source-" + first.source}>{first.source === "sqlite" ? t.localCache : t.onlineSource}</span>}</div>
    {query.isLoading && <section className="timeline-state" role="status">{t.loadingTimeline}</section>}
    {query.isError && <section className="timeline-state error-state" role="alert"><p>{t.timelineError}</p><button type="button" onClick={() => query.refetch()}>{t.retry}</button></section>}
    {first?.fallback && <p className="fallback-note" role="status">{first.fallback === "rating-filtered" ? t.ratingFallback : t.cacheFallback}</p>}
    {!query.isLoading && !query.isError && posts.length === 0 && <section className="timeline-state"><h2>{t.emptyTimeline}</h2><p>{t.emptyTimelineBody}</p></section>}
    {posts.length > 0 && <section className="timeline-list" aria-label={t.timeline}>{posts.map((post) => <PostCard key={post.id} post={post} t={t} language={language} />)}</section>}
    {posts.length > 0 && !query.hasNextPage && !query.isFetching && <p className="end-state" role="status">{t.endOfTimeline}</p>}
    {query.hasNextPage && <div className="load-more"><button type="button" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? t.loadingMore : t.loadMore}</button></div>}
  </Shell>;
}

function SettingsPage({ t, profileId, profiles }: { t: Messages; profileId: string; profiles: Profile[] }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings", profileId], queryFn: () => getSettings(profileId) });
  const mutation = useMutation({ mutationFn: (next: Settings) => saveSettings(profileId, next), onSuccess: (next) => queryClient.setQueryData(["settings", profileId], next) });
  if (query.isLoading) return <Placeholder t={t} title={t.settingsTitle} description={t.loading} />;
  if (query.isError) return <Placeholder t={t} title={t.settingsTitle} description={t.profileMissing} />;
  const s = query.data ?? {};
  const language = s.language ?? browserLanguage();
  const themeMode = s.themeMode ?? "system";
  const rating = s.rating ?? "general";
  const dataSource = s.dataSource ?? "danbooru";
  return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{t.settingsTitle}</h1></div><form className="settings-form" onSubmit={(event) => event.preventDefault()}>
    <label className="setting-row"><span>{t.profile}</span><select aria-label={t.profile} value={profileId} onChange={(event) => { localStorage.setItem(PROFILE_KEY, event.target.value); window.location.assign("/profile/" + encodeURIComponent(event.target.value)); }}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    <label className="setting-row"><span>{t.language}</span><select aria-label={t.language} value={language} onChange={(event) => mutation.mutate({ language: event.target.value as Language })}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
    <label className="setting-row"><span>{t.theme}</span><select aria-label={t.theme} value={themeMode} onChange={(event) => mutation.mutate({ themeMode: event.target.value as Settings["themeMode"] })}><option value="system">{t.system}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label>
    <label className="setting-row"><span>{t.rating}</span><select aria-label={t.rating} value={rating} onChange={(event) => mutation.mutate({ rating: event.target.value as Settings["rating"] })}>{(["general", "sensitive", "questionable", "explicit", "all"] as const).map((value) => <option key={value} value={value}>{t[value]}</option>)}</select></label>
    <label className="setting-row"><span>{t.source}</span><select aria-label={t.source} value={dataSource} onChange={(event) => mutation.mutate({ dataSource: event.target.value as Settings["dataSource"] })}><option value="danbooru">{t.online}</option><option value="sqlite">{t.local}</option></select></label>
    {mutation.isPending && <p role="status" className="form-status">{t.saving}</p>}{mutation.isError && <p role="alert" className="form-error">{t.saveFailed}</p>}
  </form></Shell>;
}

function ProfileRoute({ t, profiles }: { t: Messages; profiles: Profile[] }) {
  const { id = DEFAULT_PROFILE } = useParams();
  const active = useMemo(() => profiles.find((profile) => profile.id === id), [id, profiles]);
  useEffect(() => localStorage.setItem(PROFILE_KEY, id), [id]);
  if (profiles.length > 0 && !active) return <Placeholder t={t} title={t.profile} description={t.profileMissing} />;
  return <Shell t={t}><div className="page-heading"><p className="eyebrow">{t.profile}</p><h1>{active?.name ?? id}</h1></div><section className="empty-panel"><p>{t.readyBody}</p></section></Shell>;
}

export function App() {
  const location = useLocation();
  const profilesQuery = useQuery({ queryKey: ["profiles"], queryFn: getProfiles });
  const profiles = profilesQuery.data ?? [];
  const match = location.pathname.match(/^\/profile\/([^/]+)/);
  const routeId = match ? decodeURIComponent(match[1] ?? "") : undefined;
  const [stored, setStored] = useState(() => typeof window === "undefined" ? DEFAULT_PROFILE : localStorage.getItem(PROFILE_KEY) ?? DEFAULT_PROFILE);
  const profileId = routeId ?? stored;
  const settingsQuery = useQuery({ queryKey: ["settings", profileId], queryFn: () => getSettings(profileId), enabled: profiles.length > 0 });
  const t = messages[settingsQuery.data?.language ?? browserLanguage()];
  useEffect(() => { localStorage.setItem(PROFILE_KEY, profileId); if (profileId !== stored) queueMicrotask(() => setStored(profileId)); }, [profileId, stored]);
  return <Routes>
    <Route path="/" element={<TimelinePage t={t} profileId={profileId} ready={profiles.length > 0 && settingsQuery.isSuccess} />} />
    <Route path="/settings" element={<SettingsPage t={t} profileId={profileId} profiles={profiles} />} />
    <Route path="/profile/:id" element={<ProfileRoute t={t} profiles={profiles} />} />
    <Route path="/search" element={<SearchPage t={t} />} />
    <Route path="/bookmarks" element={<Placeholder t={t} title={t.bookmarks} description={t.placeholderBookmarks} />} />
    <Route path="/assistant" element={<Placeholder t={t} title={t.assistant} description={t.placeholderAssistant} />} />
    <Route path="*" element={<Placeholder t={t} title={t.notFound} description={t.notFoundBody} />} />
  </Routes>;
}
