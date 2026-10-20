import { type InfiniteData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, useParams } from "react-router";
import { getBookmarks, getChildren, getPost, getProfiles, getSettings, getTimeline, HttpError, saveSettings, setBookmark, type Language, type Post, type Profile, type Settings } from "./api";
import { bookmarkErrorMessage, findBookmark, updateBookmarkCache } from "./bookmark";
import { mediaView } from "./media";
import { Assistant } from "./Assistant";
import { searchQuery } from "./search";
import { Shell } from "./Shell";
import { messages, type Messages } from "./i18n";

const PROFILE_KEY = "boorux.profile";
const DEFAULT_PROFILE = "default";
function browserLanguage(): Language {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function Placeholder({ t, title, description }: { t: Messages; title: string; description: string }) {
  return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{title}</h1></div><section className="empty-panel"><p>{description}</p></section></Shell>;
}

function relativeTime(value: string, language: Language) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return value;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function BookmarkButton({ post, profileId, t }: { post: Post; profileId: string; t: Messages }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const bookmarkKey = ["bookmarks", profileId];
  const timelineKey = ["timeline", profileId];
  const detailKey = ["post", profileId, post.id];
  const bookmarked = queryClient.getQueryData<Post>(detailKey)?.isBookmarked
    ?? findBookmark(queryClient.getQueryData<InfiniteData<{ posts: Post[] }>>(timelineKey), post.id)?.post.isBookmarked
    ?? post.isBookmarked;
  const mutation = useMutation({
    mutationFn: (bookmarked: boolean) => setBookmark(post.id, profileId, bookmarked),
    onMutate: async (next) => {
      setError("");
      await queryClient.cancelQueries();
      const previous = {
        detail: queryClient.getQueryData(detailKey),
        bookmarks: queryClient.getQueryData(bookmarkKey),
        timelines: queryClient.getQueriesData({ queryKey: timelineKey }),
      };
      const location = findBookmark(previous.bookmarks as InfiniteData<{ posts: Post[] }> | undefined, post.id);
      queryClient.setQueryData(detailKey, (data: Post | undefined) => data ? { ...data, isBookmarked: next } : data);
      queryClient.setQueryData(bookmarkKey, (data: InfiniteData<{ posts: Post[] }> | undefined) => updateBookmarkCache(data, post.id, next, { remove: !next }));
      for (const [key, data] of previous.timelines) queryClient.setQueryData(key, updateBookmarkCache(data as InfiniteData<{ posts: Post[] }> | undefined, post.id, next));
      return { previous, location };
    },
    onError: (cause, next, context) => {
      queryClient.setQueryData(detailKey, context?.previous.detail);
      queryClient.setQueryData(bookmarkKey, (data) => updateBookmarkCache(data as InfiniteData<{ posts: Post[] }> | undefined, post.id, !next, { restoreAt: next ? undefined : context?.location }));
      for (const [key, data] of context?.previous.timelines ?? []) queryClient.setQueryData(key, data);
      setError(bookmarkErrorMessage(cause, t.bookmarkFailed));
    },
    onSuccess: (_result, next) => {
      queryClient.setQueryData(detailKey, (data: Post | undefined) => data ? { ...data, isBookmarked: next } : data);
      queryClient.setQueryData(bookmarkKey, (data: InfiniteData<{ posts: Post[] }> | undefined) => updateBookmarkCache(data, post.id, next, { remove: !next }));
      for (const [key, data] of queryClient.getQueriesData({ queryKey: timelineKey })) queryClient.setQueryData(key, updateBookmarkCache(data as InfiniteData<{ posts: Post[] }> | undefined, post.id, next));
    },
  });
  return <div className="bookmark-action">
    <button type="button" className={bookmarked ? "bookmark-button active" : "bookmark-button"} aria-pressed={bookmarked} disabled={mutation.isPending} onClick={() => mutation.mutate(!bookmarked)}>{bookmarked ? t.unbookmark : t.bookmark}</button>
    {error && <p className="bookmark-error" role="alert">{error}</p>}
  </div>;
}
function PostCard({ post, profileId, t, language }: { post: Post; profileId: string; t: Messages; language: Language }) {
  const preview = mediaView(post, prefersReducedMotion());
  return <article className="post-card" data-post-id={post.id}>
    <header className="post-author">
      <span className="artist-mark" aria-hidden="true">{post.artist.slice(0, 1).toUpperCase()}</span>
      <span className="artist-name">{post.artist}</span>
      <time dateTime={post.createdAt}>{relativeTime(post.createdAt, language)}</time>
      {post.isBookmarked && <span className="bookmark-state" aria-label={t.bookmarked}>{t.bookmarked}</span>}
    </header>
    <NavLink className="post-detail-link" to={"/post/" + encodeURIComponent(post.id)}>
      <h2 className="post-title">{post.title}</h2>
      {post.description && <p className="post-description">{post.description}</p>}
      <div className="post-media" style={{ aspectRatio: preview.aspectRatio }}>
        <img src={preview.src} alt={post.title} loading="lazy" decoding="async" />
        {post.mediaType === "video" && <span className="media-badge">{t.video}</span>}
        {post.mediaType === "gif" && <span className="media-badge">{t.gif}</span>}
      </div>
    </NavLink>
    <div className="post-tags">{(post.tags ?? []).slice(0, 8).map((tag) => <NavLink key={tag.id} to={"/search?tags=" + encodeURIComponent(tag.name)}>#{tag.name}</NavLink>)}</div>
    <BookmarkButton post={post} profileId={profileId} t={t} />
  </article>;
}

function PostDetailPage({ t, profileId, ready }: { t: Messages; profileId: string; ready: boolean }) {
  const { id = "" } = useParams();
  const [playing, setPlaying] = useState(false);
  const language: Language = t === messages["zh-CN"] ? "zh-CN" : "en";
  const postQuery = useQuery({ queryKey: ["post", profileId, id], queryFn: () => getPost(id, profileId), enabled: ready && Boolean(id) });
  const post = postQuery.data;
  const childrenQuery = useQuery({
    queryKey: ["post-children", profileId, id],
    queryFn: () => getChildren(id, profileId),
    enabled: ready && Boolean(post?.hasChildren),
  });
  const parentQuery = useQuery({
    queryKey: ["post-parent", profileId, post?.parentId],
    queryFn: () => getPost(post!.parentId!, profileId),
    enabled: ready && Boolean(post?.parentId),
  });
  const back = <NavLink className="back-link" to="/">{t.backToTimeline}</NavLink>;
  if (!ready || postQuery.isLoading) return <Shell t={t}><div className="page-heading"><p className="eyebrow">{t.timeline}</p><h1>{t.loadingPost}</h1></div>{back}</Shell>;
  if (postQuery.error instanceof HttpError && postQuery.error.status === 404) return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{t.notFound}</h1></div><section className="empty-panel"><p>{t.postMissing}</p>{back}</section></Shell>;
  if (postQuery.isError) return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{t.postError}</h1></div><div className="detail-actions">{back}<button type="button" onClick={() => postQuery.refetch()}>{t.retry}</button></div></Shell>;
  if (!post) return <Shell t={t}><div className="page-heading"><p className="eyebrow">BooruX</p><h1>{t.notFound}</h1></div><section className="empty-panel"><p>{t.postMissing}</p>{back}</section></Shell>;
  const view = mediaView(post, prefersReducedMotion());
  return <Shell t={t}>
    <div className="page-heading detail-heading"><div><p className="eyebrow">{t.eyebrow}</p><h1>{post.title}</h1></div>{back}</div>
    <article className="post-card detail-card" data-post-id={post.id}>
      <header className="post-author"><span className="artist-mark" aria-hidden="true">{post.artist.slice(0, 1).toUpperCase()}</span><span className="artist-name">{post.artist}</span><time dateTime={post.createdAt}>{relativeTime(post.createdAt, language)}</time>{post.isBookmarked && <span className="bookmark-state" aria-label={t.bookmarked}>{t.bookmarked}</span>}</header>
      {post.mediaType === "video" ? <div className="post-media detail-media" style={{ aspectRatio: view.aspectRatio }}>
        {playing ? <video src={view.videoSrc} poster={view.src} controls autoPlay playsInline /> : <button className="video-poster" type="button" onClick={() => setPlaying(true)}><img src={view.src} alt={post.title} /><span className="play-button">{t.playVideo}</span></button>}
      </div> : <div className="post-media detail-media" style={{ aspectRatio: view.aspectRatio }}><img src={view.src} alt={post.title} loading="eager" decoding="async" />{post.mediaType === "gif" && <span className="media-badge">{t.gif}</span>}</div>}
      <p className="detail-description">{post.description || ""}</p>
      <BookmarkButton post={post} profileId={profileId} t={t} />
      <div className="post-tags detail-tags">{(post.tags ?? []).map((tag) => <NavLink key={tag.id} to={"/search?tags=" + encodeURIComponent(tag.name)}>#{tag.name}</NavLink>)}</div>
      {parentQuery.data && <section className="relation-section"><h2>{t.parentPost}</h2><NavLink className="relation-card" to={"/post/" + encodeURIComponent(parentQuery.data.id)}><img src={parentQuery.data.previewUrl || parentQuery.data.imageUrl} alt="" loading="lazy" /><span>{parentQuery.data.title}</span></NavLink></section>}
      {post.hasChildren && childrenQuery.data?.length ? <section className="relation-section"><h2>{t.childPosts}</h2><div className="relation-grid">{childrenQuery.data.map((child) => <NavLink key={child.id} className="relation-card" to={"/post/" + encodeURIComponent(child.id)}><img src={child.previewUrl || child.imageUrl} alt="" loading="lazy" /><span>{child.title}</span></NavLink>)}</div></section> : null}
    </article>
  </Shell>;
}
function PostListPage({ t, profileId, ready, tags = "", bookmarks = false }: { t: Messages; profileId: string; ready: boolean; tags?: string; bookmarks?: boolean }) {
  const language: Language = t === messages["zh-CN"] ? "zh-CN" : "en";
  const searching = tags !== "";
  const query = useInfiniteQuery({
    queryKey: bookmarks ? ["bookmarks", profileId] : ["timeline", profileId, tags],
    queryFn: ({ pageParam }) => bookmarks
      ? getBookmarks(profileId).then((posts) => ({ posts, nextCursor: "", source: "sqlite" as const, fallback: "" as const }))
      : getTimeline(profileId, pageParam || undefined, tags || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => bookmarks ? undefined : last.nextCursor || undefined,
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
  const title = bookmarks ? t.bookmarks : searching ? tags : t.timeline;
  return <Shell t={t}>
    <div className="page-heading timeline-heading"><div><p className="eyebrow">{t.eyebrow}</p><h1>{title}</h1></div>{first && !bookmarks && <span className={"source-pill source-" + first.source}>{first.source === "sqlite" ? t.localCache : t.onlineSource}</span>}</div>
    {query.isLoading && <section className="timeline-state" role="status">{bookmarks ? t.loadingBookmarks : searching ? t.loadingSearch : t.loadingTimeline}</section>}
    {query.isError && <section className="timeline-state error-state" role="alert"><p>{bookmarks ? t.bookmarksError : searching ? t.searchError : t.timelineError}</p><button type="button" onClick={() => query.refetch()}>{t.retry}</button></section>}
    {first?.fallback && <p className="fallback-note" role="status">{first.fallback === "rating-filtered" ? t.ratingFallback : t.cacheFallback}</p>}
    {!query.isLoading && !query.isError && posts.length === 0 && <section className="timeline-state"><h2>{bookmarks ? t.emptyBookmarks : searching ? t.emptySearch : t.emptyTimeline}</h2><p>{bookmarks ? t.emptyBookmarksBody : searching ? t.emptySearchBody.replace("{tags}", tags) : t.emptyTimelineBody}</p></section>}
    {posts.length > 0 && <section className="timeline-list" aria-label={bookmarks ? t.bookmarks : searching ? t.search : t.timeline}>{posts.map((post) => <PostCard key={post.id} post={post} profileId={profileId} t={t} language={language} />)}</section>}
    {posts.length > 0 && !query.hasNextPage && !query.isFetching && <p className="end-state" role="status">{bookmarks ? t.endOfBookmarks : t.endOfTimeline}</p>}
    {query.hasNextPage && <div className="load-more"><button type="button" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? t.loadingMore : t.loadMore}</button></div>}
  </Shell>;
}

function TimelinePage({ t, profileId, ready, tags = "" }: { t: Messages; profileId: string; ready: boolean; tags?: string }) {
  return <PostListPage t={t} profileId={profileId} ready={ready} tags={tags} />;
}

function BookmarksPage({ t, profileId, ready }: { t: Messages; profileId: string; ready: boolean }) {
  return <PostListPage t={t} profileId={profileId} ready={ready} bookmarks />;
}

function SearchPage({ t, profileId, ready }: { t: Messages; profileId: string; ready: boolean }) {
  const tags = searchQuery(useLocation().search);
  if (!tags) return <Placeholder t={t} title={t.search} description={t.searchPrompt} />;
  return <TimelinePage t={t} profileId={profileId} ready={ready} tags={tags} />;
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
    <Route path="/post/:id" element={<PostDetailPage t={t} profileId={profileId} ready={profiles.length > 0 && settingsQuery.isSuccess} />} />
    <Route path="/search" element={<SearchPage t={t} profileId={profileId} ready={profiles.length > 0 && settingsQuery.isSuccess} />} />
    <Route path="/bookmarks" element={<BookmarksPage t={t} profileId={profileId} ready={profiles.length > 0 && settingsQuery.isSuccess} />} />
    <Route path="/assistant" element={<Assistant t={t} profileId={profileId} />} />
    <Route path="*" element={<Placeholder t={t} title={t.notFound} description={t.notFoundBody} />} />
  </Routes>;
}

