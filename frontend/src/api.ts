export type Language = "zh-CN" | "en";
export type ThemeMode = "system" | "light" | "dark";
export type Rating = "general" | "sensitive" | "questionable" | "explicit" | "all";
export type DataSource = "danbooru" | "sqlite";

export type Profile = { id: string; name: string };
export type Settings = {
  language?: Language;
  themeMode?: ThemeMode;
  rating?: Rating;
  dataSource?: DataSource;
};

type ProfilesResponse = { profiles?: Profile[] };
type SettingsResponse = { settings?: Settings };
type ErrorResponse = { error?: string };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & ErrorResponse;
  if (!response.ok) throw new Error(body.error || "Request failed");
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

