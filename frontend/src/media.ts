import type { Post } from "./api";

export type MediaView = {
  src: string;
  aspectRatio: number;
  animated: boolean;
  hasVideo: boolean;
  videoSrc: string;
};

export function mediaAspectRatio(post: Pick<Post, "aspectRatio" | "width" | "height">) {
  if (post.aspectRatio > 0) return post.aspectRatio;
  if (post.width > 0 && post.height > 0) return post.width / post.height;
  return 9 / 16;
}

export function mediaView(
  post: Pick<Post, "mediaType" | "imageUrl" | "previewUrl" | "aspectRatio" | "width" | "height">,
  reducedMotion: boolean,
): MediaView {
  const animated = post.mediaType === "gif" && !reducedMotion;
  return {
    src: post.mediaType === "video" || (post.mediaType === "gif" && reducedMotion)
      ? post.previewUrl || post.imageUrl
      : post.imageUrl || post.previewUrl,
    aspectRatio: mediaAspectRatio(post),
    animated,
    hasVideo: post.mediaType === "video",
    videoSrc: post.imageUrl,
  };
}