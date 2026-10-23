export type Post = {
  id: string;
  title: string;
  artist?: string;
  createdAt?: string;
  aspectRatio?: number;
  imageUrl: string;
  originalUrl?: string;
  mediaType: string;
  parentId: string | null;
  hasChildren: boolean;
  isBookmarked?: boolean;
  tags: { id: string; name: string; category: string }[];
};

export type PostsResponse = {
  success: boolean;
  posts: Post[];
  nextCursor?: string;
  source?: string;
  fallback?: string;
  error?: string;
};

export async function fetchPosts(path: string, signal: AbortSignal, field: 'posts' | 'bookmarks' = 'posts'): Promise<PostsResponse> {
  const response = await fetch(path, { signal });
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    const statusMsg = response.status ? ` (HTTP ${response.status})` : '';
    throw new Error(`服务响应异常${statusMsg}，请稍后重试`);
  }
  const { bookmarks, ...data }: PostsResponse & { bookmarks?: Post[] } = (raw && typeof raw === 'object') ? raw as any : {};
  const posts = field === 'bookmarks' ? bookmarks : data.posts;
  if (!response.ok || !data.success || !Array.isArray(posts)) {
    throw new Error(data.error || '帖子加载失败，请稍后重试');
  }
  return { ...data, posts };
}

export async function setPostBookmark(id: string, bookmarked: boolean): Promise<Post> {
  const response = await fetch(`/api/posts/${encodeURIComponent(id)}/bookmark?profileId=default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookmarked, family: !bookmarked }),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    const statusMsg = response.status ? ` (HTTP ${response.status})` : '';
    throw new Error(`服务响应异常${statusMsg}，请稍后重试`);
  }
  if (!response.ok || !data.success || data.post?.id !== id || data.post.isBookmarked !== bookmarked) {
    throw new Error(data.error || '收藏操作失败，请重试');
  }
  return data.post;
}

export function uniquePosts(posts: Post[]): Post[] {
  return [...new Map(posts.map(post => [post.id, post])).values()];
}

export function groupPosts(posts: Post[]) {
  const groups = new Map<string, Post[]>();
  for (const post of uniquePosts(posts)) {
    const id = post.parentId || post.id;
    const members = groups.get(id) || [];
    members.push(post);
    groups.set(id, members);
  }
  return [...groups].map(([id, members]) => ({ id, posts: members }));
}

export function postSource(id: string): { label: string; href?: string } {
  for (const [prefix, name, base] of [
    ['danbooru-', 'Danbooru', 'https://danbooru.donmai.us/posts/'],
    ['safebooru-', 'Safebooru', 'https://safebooru.org/index.php?page=post&s=view&id='],
    ['yandere-', 'Yande.re', 'https://yande.re/post/show/'],
  ]) {
    if (id.startsWith(prefix)) {
      const number = id.slice(prefix.length);
      return { label: `${name} #${number}`, href: base + encodeURIComponent(number) };
    }
  }
  return { label: id };
}

const RELATIVE_UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]] as const;

// 七天内显示相对时间（刚刚、5 分钟前、昨天），更早显示日期；完整时间放在 title。
export function relativeTime(date: Date, now = Date.now()): string {
  const seconds = (date.getTime() - now) / 1000;
  if (Math.abs(seconds) < 60) return '刚刚';
  if (Math.abs(seconds) < 7 * 86400) {
    const [unit, size] = RELATIVE_UNITS.find(([, size]) => Math.abs(seconds) >= size)!;
    return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(Math.round(seconds / size), unit);
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('zh-CN', sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

const LOW_RES_MEDIA =/\/(samples?|preview|thumbnails?|\d+x\d+)\/|sample_|thumbnail_|\/(sample|thumbnail)[_-]/i;

export function originalMediaURL(post: Post): string {
  const candidates = [post.originalUrl, post.imageUrl].filter((item): item is string => typeof item === 'string' && item.length > 0);
  const defaultProtocol = typeof window !== 'undefined' && window.location?.protocol && ['http:', 'https:'].includes(window.location.protocol)
    ? window.location.protocol
    : 'https:';

  for (const rawValue of candidates) {
    try {
      const value = rawValue.startsWith('//') ? `${defaultProtocol}${rawValue}` : rawValue;
      const parsed = new URL(value, `${defaultProtocol}//localhost`);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;

      const rawUpstream = parsed.searchParams.get('url');
      let upstream: URL;
      if (rawUpstream) {
        const normalizedUpstream = rawUpstream.startsWith('//') ? `${defaultProtocol}${rawUpstream}` : rawUpstream;
        upstream = new URL(normalizedUpstream, parsed.href);
        if (!['http:', 'https:'].includes(upstream.protocol)) continue;
      } else {
        upstream = parsed;
      }

      if (LOW_RES_MEDIA.test(upstream.pathname) || LOW_RES_MEDIA.test(parsed.pathname) || parsed.pathname.startsWith('/api/media/cache/')) {
        continue;
      }

      return value;
    } catch {
      continue;
    }
  }
  return '';
}
