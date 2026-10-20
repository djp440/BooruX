import { expect, test } from "bun:test";
import { getTimeline } from "./api";

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
