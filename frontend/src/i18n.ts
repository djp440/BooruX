import type { Language } from "./api";

export const messages = {
  "zh-CN": {
    timeline: "时间线", search: "搜索", bookmarks: "收藏", assistant: "AI 助手", settings: "设置",
    skip: "跳到主要内容", railNote: "浏览作品，不伪装社交功能。", eyebrow: "Web MVP",
    ready: "准备开始浏览", readyBody: "连接现有 BooruX 后端后，作品、搜索与收藏会在这里呈现。",
    next: "下一步", nextBody: "先从设置中选择 Profile 与内容分级，再开启你的时间线。", openSettings: "打开设置",
    settingsTitle: "设置", profile: "Profile", language: "界面语言", theme: "主题", rating: "内容分级", source: "数据源",
    system: "跟随系统", light: "浅色", dark: "深色", general: "General", sensitive: "Sensitive",
    questionable: "Questionable", explicit: "Explicit", all: "全部", online: "在线优先", local: "仅本地缓存",
    loading: "正在加载设置…", saving: "正在保存…", saveFailed: "保存失败，请重试。", profileMissing: "找不到这个 Profile。",
    loadingTimeline: "正在加载时间线…", loadingMore: "正在加载更多…", loadMore: "加载更多", retry: "重试",
    timelineError: "时间线加载失败。请检查连接后重试。", cacheFallback: "Online Source 暂不可用，当前显示 Local Cache。",
    ratingFallback: "在线结果不符合当前 Rating，已改用 Local Cache。", localCache: "Local Cache", onlineSource: "Online Source",
    emptyTimeline: "时间线还是空的", emptyTimelineBody: "当前 Profile 还没有可显示的作品。",
    endOfTimeline: "已经到底了。", video: "视频", gif: "GIF", bookmarked: "已收藏",
    searchComingSoon: "标签「{tags}」的搜索将在下一阶段接入。",
    notFound: "页面不存在", notFoundBody: "这个地址没有对应的页面。", navLabel: "主导航", explore: "探索",
    placeholderSearch: "搜索功能将在下一阶段接入。", placeholderBookmarks: "收藏功能将在后续阶段接入。",
    placeholderAssistant: "AI 助手将在后续阶段接入。",
  },
  en: {
    timeline: "Timeline", search: "Search", bookmarks: "Bookmarks", assistant: "AI assistant", settings: "Settings",
    skip: "Skip to main content", railNote: "Browse posts without pretending social features exist.", eyebrow: "Web MVP",
    ready: "Ready to browse", readyBody: "Posts, search and bookmarks will appear here once connected to the BooruX backend.",
    next: "Next step", nextBody: "Choose a Profile and Rating in Settings to start your Timeline.", openSettings: "Open settings",
    settingsTitle: "Settings", profile: "Profile", language: "Language", theme: "Theme", rating: "Rating", source: "Data source",
    system: "System", light: "Light", dark: "Dark", general: "General", sensitive: "Sensitive",
    questionable: "Questionable", explicit: "Explicit", all: "All", online: "Online first", local: "Local cache only",
    loading: "Loading settings…", saving: "Saving…", saveFailed: "Could not save changes. Try again.", profileMissing: "This Profile could not be found.",
    loadingTimeline: "Loading Timeline…", loadingMore: "Loading more…", loadMore: "Load more", retry: "Retry",
    timelineError: "The Timeline could not load. Check your connection and retry.", cacheFallback: "The Online Source is unavailable; showing Local Cache.",
    ratingFallback: "Online results did not match this Profile's Rating; showing Local Cache.", localCache: "Local Cache", onlineSource: "Online Source",
    emptyTimeline: "The Timeline is empty", emptyTimelineBody: "This Profile has no posts to show.",
    endOfTimeline: "You've reached the end.", video: "Video", gif: "GIF", bookmarked: "Bookmarked",
    searchComingSoon: "Search for tag \"{tags}\" will be connected in the next slice.",
    notFound: "Page not found", notFoundBody: "There is no page at this address.", navLabel: "Primary navigation", explore: "Explore",
    placeholderSearch: "Search will be connected in the next slice.", placeholderBookmarks: "Bookmarks will be connected in a later slice.",
    placeholderAssistant: "The AI assistant will be connected in a later slice.",
  },
} as const;

export type Messages = (typeof messages)[Language];

