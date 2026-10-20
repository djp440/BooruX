# BooruX

BooruX 是一个以作品（Post）浏览、收藏和 Profile 配置为核心的 Booru 客户端；Web 界面借鉴 X 的信息架构，但不把尚不存在的社交能力伪装成可用功能。

## Language

**作品（Post）**：
由在线 Booru 源返回、可被收藏的单条图像或视频内容。
_Avoid_: 推文、Tweet、帖子

**Artist**：
作品元数据中的创作者标签，不是站内用户账号。
_Avoid_: 用户、账号、作者主页

**BooruX Profile**：
保存在本地后端的浏览配置集合，包含收藏、搜索历史和内容分级设置。
_Avoid_: 社交账号、用户、关注者

**Timeline**：
按在线源顺序展示作品的主界面，不包含站内社交关系产生的动态。
_Avoid_: Feed、关注流

**Rating**：
作品的 Booru 内容分级：general、sensitive、questionable 或 explicit；Profile 的 Rating 为单一允许值，all 表示不限制。
_Avoid_: 安全等级、成人开关

**Online Source**：
提供作品元数据和媒体的远程 Booru 服务。
_Avoid_: 缓存、本地库

**Source Fallback**：
一个 Online Source 不可用时，自动尝试下一个 Online Source 的过程。
_Avoid_: 换源、离线模式

**Local Cache**：
SQLite 中保存的作品与元数据；当 Online Source 不可用时作为 Timeline 的备用数据。
_Avoid_: 在线库、远程缓存
