import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation, useParams } from "react-router";
import { getProfiles, getSettings, saveSettings, type Language, type Profile, type Settings } from "./api";
import { Assistant } from "./Assistant";
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
  if (routeId && routeId !== stored) { localStorage.setItem(PROFILE_KEY, routeId); setStored(routeId); }  const profileId = routeId ?? stored;
  const settingsQuery = useQuery({ queryKey: ["settings", profileId], queryFn: () => getSettings(profileId), enabled: profiles.length > 0 });
  const t = messages[settingsQuery.data?.language ?? browserLanguage()];
  useEffect(() => { localStorage.setItem(PROFILE_KEY, profileId); queueMicrotask(() => setStored(profileId)); }, [profileId]);
  return <Routes>
    <Route path="/" element={<Shell t={t} />} />
    <Route path="/settings" element={<SettingsPage t={t} profileId={profileId} profiles={profiles} />} />
    <Route path="/profile/:id" element={<ProfileRoute t={t} profiles={profiles} />} />
    <Route path="/search" element={<Placeholder t={t} title={t.search} description={t.placeholderSearch} />} />
    <Route path="/bookmarks" element={<Placeholder t={t} title={t.bookmarks} description={t.placeholderBookmarks} />} />
    <Route path="/assistant" element={<Assistant t={t} profileId={profileId} />} />
    <Route path="*" element={<Placeholder t={t} title={t.notFound} description={t.notFoundBody} />} />
  </Routes>;
}
