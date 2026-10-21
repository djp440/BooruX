export type Post = {
  id: string;
  title: string;
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
  const { bookmarks, ...data }: PostsResponse & { bookmarks?: Post[] } = await response.json();
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
  const data = await response.json();
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

export function originalMediaURL(post: Post): string {
  const value = post.originalUrl || post.imageUrl;
  if (!value) return '';
  try {
    const parsed = new URL(value, 'http://localhost');
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const upstream = new URL(parsed.searchParams.get('url') || parsed.href);
    if (/\/(sample|\d+x\d+)\//.test(upstream.pathname) || parsed.pathname.startsWith('/api/media/cache/')) return '';
    return value;
  } catch {
    return '';
  }
}
