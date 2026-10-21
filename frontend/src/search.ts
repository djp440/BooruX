const HISTORY_KEY = 'boorux:tag-search-history:v1';
const HISTORY_LIMIT = 20;
export const SEARCH_MAX_LENGTH = 500;
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeTagQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function searchCacheKey(query: string): string {
  const normalized = normalizeTagQuery((query || '').slice(0, SEARCH_MAX_LENGTH));
  return normalized ? `feed:default:tags:${normalized}` : 'feed:default';
}

export function readSearchHistory(storage?: HistoryStorage): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= SEARCH_MAX_LENGTH)
      .map(normalizeTagQuery).filter(Boolean))].slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveSearchHistory(history: string[], query: string, storage?: HistoryStorage): string[] {
  const normalized = normalizeTagQuery(query);
  const next = normalized ? [normalized, ...history.filter(item => item !== normalized)].slice(0, HISTORY_LIMIT) : history;
  try {
    (storage ?? localStorage).setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 历史记录存储不可用时，当前页面仍可搜索和查看历史。
  }
  return next;
}

export function clearSearchHistory(storage?: HistoryStorage): void {
  try {
    (storage ?? localStorage).setItem(HISTORY_KEY, '[]');
  } catch {
    // 与保存一致，存储异常不阻断搜索。
  }
}
