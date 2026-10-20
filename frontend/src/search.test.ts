import { expect, test } from "bun:test";
import { searchPath, searchQuery } from "./search";

test("search path preserves a space-separated tag query", () => {
  expect(searchPath("  cat_ears  blue_eyes ")).toBe("/search?tags=cat_ears+blue_eyes");
});

test("search query restores the URL contract", () => {
  expect(searchQuery("?tags=cat_ears+blue_eyes")).toBe("cat_ears blue_eyes");
  expect(searchQuery("?tags=")).toBe("");
});
