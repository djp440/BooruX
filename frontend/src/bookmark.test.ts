import { expect, test } from "bun:test";
import { bookmarkErrorMessage, updateBookmarkCache } from "./bookmark";
import { HttpError, type Post } from "./api";

const makePost = (id: string, isBookmarked: boolean): Post => ({
  id, title: id, artist: "a", imageUrl: "", previewUrl: "", aspectRatio: 1, width: 1, height: 1,
  isBookmarked, rating: "general", createdAt: "", mediaType: "image",
});

test("optimistic bookmark updates every cached copy", () => {
  const data = { pages: [{ posts: [makePost("post-1", false), makePost("post-2", true)] }, { posts: [makePost("post-1", false)] }], pageParams: [""] };
  const next = updateBookmarkCache(data, "post-1", true);
  expect(next?.pages.map((page) => page.posts.map((post) => post.isBookmarked))).toEqual([[true, true], [true]]);
  expect(data.pages[0]?.posts[0]?.isBookmarked).toBe(false);
});

test("bookmarks route removes on unbookmark and restores at the same position", () => {
  const data = { pages: [{ posts: [makePost("post-1", true), makePost("post-2", true)] }], pageParams: [""] };
  const removed = updateBookmarkCache(data, "post-1", false, { remove: true });
  expect(removed?.pages[0]?.posts.map((post) => post.id)).toEqual(["post-2"]);
  const restored = updateBookmarkCache(removed, "post-1", true, { restoreAt: { pageIndex: 0, postIndex: 0, post: makePost("post-1", true) } });
  expect(restored?.pages[0]?.posts.map((post) => post.id)).toEqual(["post-1", "post-2"]);
});

test("bookmark failure prefers the server explanation", () => {
  expect(bookmarkErrorMessage(new HttpError(403, "评级不允许"), "fallback")).toBe("评级不允许");
  expect(bookmarkErrorMessage(new Error("offline"), "fallback")).toBe("fallback");
});
