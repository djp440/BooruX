import { expect, test } from "bun:test";
import { getPost, HttpError, postFromResponse } from "./api";

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