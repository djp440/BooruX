import { expect, test } from "bun:test";
import { mediaView } from "./media";

const base = { aspectRatio: 0, width: 1200, height: 800, imageUrl: "full.gif", previewUrl: "still.jpg", mediaType: "gif" as const };

test("GIF stays animated only when motion is allowed", () => {
  expect(mediaView(base, false)).toEqual({ src: "full.gif", aspectRatio: 1.5, animated: true, hasVideo: false, videoSrc: "full.gif" });
  expect(mediaView(base, true)).toEqual({ src: "still.jpg", aspectRatio: 1.5, animated: false, hasVideo: false, videoSrc: "full.gif" });
});

test("video uses its poster until played and falls back to 9:16 without dimensions", () => {
  expect(mediaView({ ...base, mediaType: "video" }, false)).toEqual({ src: "still.jpg", aspectRatio: 1.5, animated: false, hasVideo: true, videoSrc: "full.gif" });
  expect(mediaView({ ...base, mediaType: "image", aspectRatio: 0, width: 0, height: 0 }, false).aspectRatio).toBe(9 / 16);
});