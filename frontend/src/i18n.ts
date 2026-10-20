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
    notFound: "页面不存在", notFoundBody: "这个地址没有对应的页面。", navLabel: "主导航", explore: "探索",
    placeholderSearch: "搜索功能将在下一阶段接入。", placeholderBookmarks: "收藏功能将在后续阶段接入。",
    assistantUnconfigured: "AI 助手尚未配置", assistantUnconfiguredBody: "当前还没有可用的 AI Provider。请先在设置中完成配置，再回来开始对话。",
    assistantReadyBody: "可以询问作品、标签或收藏信息。", model: "模型", chooseModel: "选择模型", chooseModelBody: "请选择一个可用模型开始对话。",
    clearChat: "清空对话", clearConfirm: "确定清空当前对话和附件吗？", chatFailed: "对话请求失败，请重试。",
    generating: "正在生成…", stop: "停止", retry: "重试", attach: "添加图片", messagePlaceholder: "输入消息", send: "发送", attachmentsMax: "最多 4 张",   },
  en: {
    timeline: "Timeline", search: "Search", bookmarks: "Bookmarks", assistant: "AI assistant", settings: "Settings",
    skip: "Skip to main content", railNote: "Browse posts without pretending social features exist.", eyebrow: "Web MVP",
    ready: "Ready to browse", readyBody: "Posts, search and bookmarks will appear here once connected to the BooruX backend.",
    next: "Next step", nextBody: "Choose a Profile and Rating in Settings to start your Timeline.", openSettings: "Open settings",
    settingsTitle: "Settings", profile: "Profile", language: "Language", theme: "Theme", rating: "Rating", source: "Data source",
    system: "System", light: "Light", dark: "Dark", general: "General", sensitive: "Sensitive",
    questionable: "Questionable", explicit: "Explicit", all: "All", online: "Online first", local: "Local cache only",
    loading: "Loading settings…", saving: "Saving…", saveFailed: "Could not save changes. Try again.", profileMissing: "This Profile could not be found.",
    notFound: "Page not found", notFoundBody: "There is no page at this address.", navLabel: "Primary navigation", explore: "Explore",
    placeholderSearch: "Search will be connected in the next slice.", placeholderBookmarks: "Bookmarks will be connected in a later slice.",
    assistantUnconfigured: "AI assistant is not configured", assistantUnconfiguredBody: "No AI Provider is available yet. Configure one in Settings, then come back to start chatting.",
    assistantReadyBody: "Ask about posts, tags or bookmarks.", model: "Model", chooseModel: "Choose a model", chooseModelBody: "Choose an available model to start chatting.",
    clearChat: "Clear chat", clearConfirm: "Clear this conversation and its attachments?", chatFailed: "The chat request failed. Try again.",
    generating: "Generating…", stop: "Stop", retry: "Retry", attach: "Add images", messagePlaceholder: "Message", send: "Send", attachmentsMax: "4 max",   },
} as const;

export type Messages = (typeof messages)[Language];

