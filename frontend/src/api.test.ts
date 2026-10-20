import { expect, test } from "bun:test";
import { getBookmarks, getPost, getTimeline, HttpError, postFromResponse, setBookmark } from "./api";

test("detail response normalizes missing optional fields", () => {
  const post = postFromResponse({ id: "post-1", title: "One", mediaType: "video" });
  expect(post.id).toBe("post-1");
  expect(post.tags).toEqual([]);
  expect(post.hasChildren).toBe(false);
  expect(post.parentId).toBeUndefined();
});

test("detail request carries the active profile", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ post: { id: "post-1", title: "One", tags: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    await getPost("post-1", "profile one");
    expect(requested).toBe("/api/posts/post-1?profileId=profile%20one");
  } finally {
    globalThis.fetch = original;
  }
});

test("detail 404 stays distinguishable from a connection failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Post not found" }), { status: 404 })) as unknown as typeof fetch;
  try {
    await expect(getPost("missing", "default")).rejects.toBeInstanceOf(HttpError);
    try {
      await getPost("missing", "default");
    } catch (error) {
      expect((error as HttpError).status).toBe(404);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("timeline-style search carries the query and cursor", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ posts: [], nextCursor: "", source: "sqlite" }), { status: 200 });
  }) as typeof fetch;
  try {
    await getTimeline("profile one", "next cursor", "cat_ears blue_eyes");
    expect(requested).toBe("/api/danbooru/posts?profileId=profile+one&limit=12&cursor=next+cursor&tags=cat_ears+blue_eyes");
  } finally {
    globalThis.fetch = original;
  }
});

test("bookmark mutation carries the active profile and explicit state", async () => {
  const original = globalThis.fetch;
  let requestPath = "";
  let requestBody = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestPath = String(input);
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ post: { id: "post-1", title: "One", isBookmarked: true } }), { status: 200 });
  }) as typeof fetch;
  try {
    const post = await setBookmark("post-1", "profile one", true);
    expect(requestPath).toBe("/api/posts/post-1/bookmark?profileId=profile%20one");
    expect(JSON.parse(requestBody)).toEqual({ bookmarked: true });
    expect(post.isBookmarked).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("bookmarks request reads only the active profile", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ bookmarks: [{ id: "post-1", title: "One", isBookmarked: true }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const posts = await getBookmarks("profile one");
    expect(requested).toBe("/api/profiles/profile%20one/bookmarks");
    expect(posts.map((post) => post.id)).toEqual(["post-1"]);
  } finally {
    globalThis.fetch = original;
  }
});
