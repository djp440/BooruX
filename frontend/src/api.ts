export type Language = "zh-CN" | "en";
export type ThemeMode = "system" | "light" | "dark";
export type Rating = "general" | "sensitive" | "questionable" | "explicit" | "all";
export type DataSource = "danbooru" | "sqlite";

export type Profile = { id: string; name: string };
export type Post = {
  id: string;
  title: string;
  artist: string;
  imageUrl: string;
  previewUrl: string;
  aspectRatio: number;
  width: number;
  height: number;
  isBookmarked: boolean;
  rating: Exclude<Rating, "all">;
  createdAt: string;
  description?: string;
  mediaType: "image" | "gif" | "video";
  parentId?: string;
  hasChildren?: boolean;
  tags?: { id: string; name: string; category: string }[];
};
export type TimelinePage = {
  posts: Post[];
  nextCursor: string;
  source: "danbooru" | "sqlite";
  fallback?: "online-unavailable" | "rating-filtered" | "";
};
export type Settings = {
  language?: Language;
  themeMode?: ThemeMode;
  rating?: Rating;
  dataSource?: DataSource;
};

type ProfilesResponse = { profiles?: Profile[] };
type SettingsResponse = { settings?: Settings };
type ErrorResponse = { error?: string };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & ErrorResponse;
  if (!response.ok) throw new HttpError(response.status, body.error || "Request failed");
  return body;
}

export const getProfiles = () =>
  request<ProfilesResponse>("/api/profiles").then((body) => body.profiles ?? []);

export const getSettings = (profileId: string) =>
  request<SettingsResponse>("/api/profiles/" + encodeURIComponent(profileId) + "/settings").then(
    (body) => body.settings ?? {},
  );

export const saveSettings = (profileId: string, settings: Settings) =>
  request<SettingsResponse>("/api/profiles/" + encodeURIComponent(profileId) + "/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  }).then((body) => body.settings ?? {});

export const getTimeline = (profileId: string, cursor?: string, tags?: string) => {
  const params = new URLSearchParams({ profileId, limit: "12" });
  if (cursor) params.set("cursor", cursor);
  if (tags) params.set("tags", tags);
  return request<Partial<TimelinePage>>("/api/danbooru/posts?" + params).then((body) => ({
    posts: body.posts ?? [],
    nextCursor: body.nextCursor ?? "",
    source: body.source ?? "sqlite",
    fallback: body.fallback ?? "",
  }));
};

export function postFromResponse(body: Partial<Post>): Post {
  return {
    id: body.id ?? "",
    title: body.title ?? "",
    artist: body.artist ?? "",
    imageUrl: body.imageUrl ?? "",
    previewUrl: body.previewUrl ?? "",
    aspectRatio: body.aspectRatio ?? 0,
    width: body.width ?? 0,
    height: body.height ?? 0,
    isBookmarked: body.isBookmarked ?? false,
    rating: body.rating ?? "general",
    createdAt: body.createdAt ?? "",
    description: body.description ?? "",
    mediaType: body.mediaType ?? "image",
    parentId: body.parentId || undefined,
    hasChildren: body.hasChildren ?? false,
    tags: body.tags ?? [],
  };
}

export const getPost = (id: string, profileId: string) =>
  request<{ post?: Partial<Post> }>("/api/posts/" + encodeURIComponent(id) + "?profileId=" + encodeURIComponent(profileId))
    .then((body) => postFromResponse(body.post ?? {}));

export const getChildren = (id: string, profileId: string) =>
  request<{ posts?: Partial<Post>[] }>("/api/posts/" + encodeURIComponent(id) + "/children?profileId=" + encodeURIComponent(profileId))
    .then((body) => (body.posts ?? []).map(postFromResponse));

