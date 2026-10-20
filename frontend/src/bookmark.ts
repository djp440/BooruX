import { type InfiniteData } from "@tanstack/react-query";
import { HttpError, type Post, type TimelinePage } from "./api";

type PostPage = Pick<TimelinePage, "posts">;
type BookmarkData = InfiniteData<PostPage>;
export type BookmarkLocation = { pageIndex: number; postIndex: number; post: Post };

export function findBookmark(data: BookmarkData | undefined, id: string): BookmarkLocation | undefined {
  for (const [pageIndex, page] of (data?.pages ?? []).entries()) {
    const postIndex = page.posts.findIndex((post) => post.id === id);
    if (postIndex >= 0) return { pageIndex, postIndex, post: page.posts[postIndex]! };
  }
}

export function updateBookmarkCache<T extends PostPage>(
  data: InfiniteData<T> | undefined,
  id: string,
  bookmarked: boolean,
  options: { remove?: boolean; restoreAt?: BookmarkLocation } = {},
) {
  if (!data) return data;
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    posts: page.posts.flatMap((post) => {
      if (post.id !== id) return [post];
      found = true;
      return options.remove && !bookmarked ? [] : [{ ...post, isBookmarked: bookmarked }];
    }),
  }));
  const restore = options.restoreAt;
  if (!found && bookmarked && restore) {
    const page = pages[restore.pageIndex];
    if (page) {
      const posts = [...page.posts];
      posts.splice(Math.min(restore.postIndex, posts.length), 0, { ...restore.post, isBookmarked: true });
      pages[restore.pageIndex] = { ...page, posts };
    }
  }
  return { ...data, pages };
}

export function bookmarkErrorMessage(error: unknown, fallback: string) {
  return error instanceof HttpError ? error.message : fallback;
}
