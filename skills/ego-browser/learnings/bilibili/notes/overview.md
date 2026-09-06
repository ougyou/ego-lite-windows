# Bilibili Overview

## Page structure

- Nav search box: `#nav-searchform input.nav-search-input`
- Video player: `video` element (check `paused` / `readyState` / `currentTime`)
- Uploader video list (space page): `.bili-video-card` cards; each card's link is
  `a.bili-video-card__cover` → `//www.bilibili.com/video/BV...`

## Gotchas（踩过的坑）

1. **空间页顶部站方推广会误导"取最近视频"**：space 视频页顶部 banner /「首页」
   导航可能指向站方推广视频（如官方账号"22和33"的 2233 生日曲），全页第一个
   `a[href*="/video/BV"]` 不一定属于该 UP 主。**必须限定 `.bili-video-card`
   投稿列表**取视频，忽略顶部推广。
2. **中文输入 / 搜索**：cmd 没有 heredoc，一律写 UTF-8 `.js` 文件后用
   `ego-browser nodejs < task.js` 喂入（文件字节原样进 stdin，中文不丢）。
   若内容是内联拼接 / 经 echo 粘贴（受控制台代码页影响）仍可能乱码，稳妥
   起见脚本内中文用 `\uXXXX` 转义（如"慢学AI" = `\u6162\u5b66AI`）。
3. **投稿接口限流**：`x/space/arc/search` 返回 -799、wbi 版 -403 → 用页面列表
   定位视频（`.bili-video-card`），不要依赖投稿接口。
4. **新开 tab 后 page 需确认 attach**：`openOrReuseTab` 打开新 tab 后 `page`
   不会自动 attach 到它；先 `browser.switchTab(target)` 再**轮询 `page.url()`
   直到指向目标**再读取（否则读到 about:blank / 空）。
5. **验证视频归属用官方接口**：`https://api.bilibili.com/x/web-interface/view?bvid=BVxxx`
   返回 `data.owner.name` / `data.title` / `data.pubdate`，用于确认视频确实是
   目标 UP 主、且是最新发布。

## Recommended flow（单 tab 顺序导航）

1. `page.goto('https://search.bilibili.com/upuser?keyword=' + encodeURIComponent(name))`
   → 用户 tab，从卡片文本匹配 UP 主空间链接。
2. `page.goto(space + '/video')` → 空间视频页（最新发布排序）。
3. 用 `get_recent_video`（见 manifest）取最近视频。
4. `page.goto(videoUrl)` → 确认 `video.paused === false` 且在播放。
