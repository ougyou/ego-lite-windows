# Spike：个人接管模式可行性验证（2026-09-06）

- 关联 spec：`docs/superpowers/specs/2026-09-06-ego-browser-personal-takeover-design.md`
- 执行：计划 Task 1；用户不在场授权自主执行 → **全部 headless + 临时 profile + 本地 file:// 离线页**，
  未触碰真实 chrome_workspace / 日常 Chrome / 未联网。

## 环境

- 临时 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe --headless=new
  --remote-debugging-port=9333 --user-data-dir=%TEMP%\ego-spike\profile`（仅临时目录）。
- 已有 tab = `%TEMP%\ego-spike\www\p1..p4.html`（本地 file:// 页）。
- 接管方式 = `EGO_LINUX_CDP_URL=ws://127.0.0.1:9333/devtools/browser/<id> node runtime\ego-linux\bin\ego-browser.mjs nodejs < script.js`，`XDG_STATE_HOME` 指向临时 state。

## 实测结果

### A：接管 + 列现有 tab（PASS）
- `browser.listTabs()` 列出外部 Chrome **默认 context 全部现有 file tab**（MRU 序，active 正确）。
- chrome 内部扩展/omnibox target 被 `type==='page'` 过滤排除，不污染列表。
- 关键：facade `browser.listTabs()` 返回 **数组**（不是 `{tabs}`）；`ego.listTabs()` 才返回 `{tabs}`。

### B：无 task space 时直接驱动外部 tab（PASS）
- `openOrReuseTab(p1)`（已存在）→ 复用，file tab 数不变（2→2）。
- `openOrReuseTab(p3)`（新）→ 新开一个 tab，落**默认 context**，计数 +1（2→3），并成为 active。
- `page.snapshot()` 在新 tab 上正常；`switchTab(p1)` 切回成功；`page.goto(p2)` 在当前 tab 导航成功。
- 结论：无选中 space 时 `listTabs` 无 scope → 返回全部 page target；新开 tab（`createTab(url)` 不带
  `browserContextId`）落默认 context。即"就地驱动现有 tab、不做隔离"**天然可行**。

### C：非隔离 personal 伪空间（adopt 机制，PASS）
- 预写 state：`selectedId='personal'`、空间 `{ browserContextId:null, targetIds:[3 个现有 file tab] }`。
- `listTabs()` 按 targetIds **scoped** 返回这 3 个（ADOPT_LIST=3）。
- 复用已存在 URL 计数不变；新开被计入空间并列出；**`Target.getBrowserContexts` 恒为 0** → 全程未创建
  隔离 context（登录/会话共享默认 jar）。
- 结论：Task 5 方案成立——把默认 context 现有 page target 登记进一个 `browserContextId=null` 的
  "personal" 空间，`tabs.mjs` 既有"无 context 空间按 targetIds 归属"路径直接支持；新 tab 用
  `createTab(url)`（不带 context）落默认 context 并被跟踪。

## 发现 / 对实现的约束

1. **facade 返回形状**：`browser.listTabs()` 是数组。SKILL 示例/脚本须用数组语义
   （或 `const t = (await browser.listTabs())` 直接当数组）。
2. `openOrReuseTab` 按 URL 精确匹配；被 goto 导航走的 tab 不再匹配原 URL（语义合理，不视为缺陷）。
3. **伪空间仍有价值**（不只是为了列 tab）：提供 tab 卫生边界——`closeTab` 只关本任务新增/登记的 tab、
   不误关用户原有 tab；并使 task-space 状态文件语义一致。adopt 实现 = Task 5 的 `adoptPersonalSpace`。
4. 无需对 `createTabInSelectedSpace` 做隔离分支改造；只要 selected 空间 `browserContextId=null`，
   现有代码就落默认 context（spike C 已证）。
5. `--headless=new` + 单 URL 启动稳定；双 URL 一次性启动曾异常退出（与功能无关，测试时逐个开）。

## 决策

- **PASS**：外部默认 context 现有 tab 可无隔离接管驱动；Task 5 采用"非隔离伪空间 + targetIds 登记 +
  createTab 不带 context"。
- 无需回退 playwright-cli。后续任务按计划推进（Task 2..6），真实 chrome_workspace 只读冒烟留待用户在场。
