export const RATING_OPTIONS = [
  { value: 'general', label: '全年龄', description: '仅显示 general（全年龄）内容。' },
  { value: 'sensitive', label: '敏感', description: '显示 sensitive（敏感）内容。' },
  { value: 'questionable', label: '成人', description: '显示 questionable（成人）内容。' },
  { value: 'explicit', label: '限制级', description: '显示 explicit（限制级）内容。' },
  { value: 'all', label: '全部', description: '不限制年龄分级。' },
] as const;

export type Rating = typeof RATING_OPTIONS[number]['value'];

export function isRating(value: unknown): value is Rating {
  return typeof value === 'string' && RATING_OPTIONS.some(option => option.value === value);
}

export const THEME_OPTIONS = [
  { value: 'light', label: '浅色', description: '始终使用浅色背景。' },
  { value: 'dark', label: '暗色', description: '始终使用暗色背景。' },
  { value: 'system', label: '跟随系统', description: '随设备的外观设置自动切换。' },
] as const;

export type Theme = typeof THEME_OPTIONS[number]['value'];
// 标签屏蔽：与后端 tagfilter.go 的 tagFilter 结构一致；白名单等其它字段原样保留，保存时不覆盖。
export type TagFilter = { blacklistEnabled: boolean; blacklist: string[]; [key: string]: unknown };
export type SettingsData = { rating: Rating; themeMode: Theme; tagFilter: TagFilter };
export const TAG_FILTER_MAX = 200;

// 与后端 normalizeTag 规则一致：去首尾空白与开头的 #，小写，空白转下划线，最长 100 字符。
export function normalizeFilterTag(value: string): string {
  return Array.from(value.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '_')).slice(0, 100).join('');
}

export function readTagFilter(value: unknown): TagFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { blacklistEnabled: false, blacklist: [] };
  const raw = value as Record<string, unknown>;
  const blacklist = Array.isArray(raw.blacklist) ? raw.blacklist.filter((tag): tag is string => typeof tag === 'string') : [];
  return { ...raw, blacklistEnabled: raw.blacklistEnabled === true, blacklist };
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEME_OPTIONS.some(option => option.value === value);
}

export async function fetchSettings(signal: AbortSignal): Promise<SettingsData> {
  const response = await fetch('/api/settings?profileId=default', { signal });
  const data = await response.json();
  if (!response.ok || !data.success || typeof data.settings !== 'object') {
    throw new Error(data.error || '设置加载失败，请重试');
  }
  return {
    rating: isRating(data.settings.rating) ? data.settings.rating : 'general',
    themeMode: isTheme(data.settings.themeMode) ? data.settings.themeMode : 'system',
    tagFilter: readTagFilter(data.settings.tagFilter),
  };
}

export async function saveRating(rating: Rating): Promise<void> {
  await saveSettings({ rating });
}

export async function saveSettings(settings: Partial<SettingsData>): Promise<void> {
  const response = await fetch('/api/settings?profileId=default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || '设置保存失败，请重试');
  if (settings.rating && data.settings?.rating !== settings.rating) throw new Error('年龄分级保存失败，请重试');
  if (settings.themeMode && data.settings?.themeMode !== settings.themeMode) throw new Error('背景色保存失败，请重试');
  if (settings.tagFilter) {
    const saved = readTagFilter(data.settings?.tagFilter);
    if (saved.blacklistEnabled !== settings.tagFilter.blacklistEnabled || saved.blacklist.join(' ') !== settings.tagFilter.blacklist.join(' ')) {
      throw new Error('标签屏蔽保存失败，请重试');
    }
  }
}

export const THEME_STORAGE_KEY = 'boorux:theme';

export function applyTheme(theme: Theme, persist: boolean = true): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 存储不可用时仍应用当前页面主题。
    }
  }
}

export function readCachedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}
