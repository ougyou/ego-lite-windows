# ego-browser tab 卫生与经验沉淀设计（2026-08-16）

> 状态：**待用户审查**（brainstorming 阶段，未实现）。
> 来源：第三轮 brainstorming。用户在真实案例（2026-08-16 百度→bilibili→
> 慢学AI→最近视频，全程 8+ 次 heredoc）后提出三个优化点。
> 本仓库非 git 仓库，无法 commit（沿用前几轮说明）。

## 1. 背景与问题

真实案例暴露三个问题：

1. **每步操作都新开 tab，堆积且易出错**
   - 根因：SKILL 现指导 `Prefer browser.openOrReuseTab(...)`；`openOrReuseTab`
     的"复用"按 URL 匹配，操作链每个 URL 都不同 → 每步新增 tab（案例最终
     堆到 6 个）。新开 tab 后 `page` 不会自动 attach 到它，脚本要么轮询等
     attach、要么没等就绪就读 → 取空/报错 → 重做。正是"页面未加载 js 就去
     读新 tab"。
2. **任务完成后未清理生成的临时脚本**
   - 本次在 `bilibili_task/` 留下 `r1-r7.js` 等（辅助 probe/run 已清理）。
     需要明确"临时脚本是否清理、产物如何保留"的规范。
3. **是否增加后置步骤沉淀 skill 经验**
   - 本次学到 bilibili 大量经验（站方推广误导取最近视频、中文编码坑、
     投稿接口限流、page attach 轮询、用官方接口验证视频归属），目前
     `learnings/` 只有 google、x-com，无 bilibili。

## 2. 目标

- **语义驱动的 tab 策略**：默认单 tab 顺序导航（目标导向，中间步骤是路径），
  多开 tab 仅当用户语义明确需要（对比 / 并行 / 保留参考页）。
- **明确的临时脚本生命周期**：任务收尾清理临时脚本，产物保留到可见位置。
- **轻量 learnings 后置沉淀**：可选、agent 自主，不引入复杂机制。

## 3. 问题 1 方案对比

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A. 文档强约束（推荐）** | SKILL 改为"**语义驱动 + 默认单 tab**"：优先 `page.goto` 当前 tab 顺序导航；`openOrReuseTab` 仅当用户语义明确需要多页；导航后先确认 `page` 指向目标再读；收尾 `closeTab` 清理 | 零运行时改动、立即见效、根治"读新 tab 出错" | 依赖 agent 遵守 |
| **B. A + 运行时改进** | A 之上再改 `openOrReuseTab`：新开 tab 后自动激活/attach，或新增稳定的"当前 tab 导航"封装 | 即使误用 openOrReuseTab 也不再错 | 动 vendored 运行时，成本高；需评估是否必要 |
| **C. 只修运行时 attach 竞态** | 不改文档策略，只修新开 tab 后 page 不 attach | 修掉一类错误 | 仍每步新开 tab，堆积不解决 |

**推荐 A**：问题本质是"策略"（不该每步新开）而非单纯"运行时 bug"。先以文档
约束为主；若后续仍频繁出现 attach 竞态，再评估 B（运行时小改，登记 PATCHES）。

## 4. 设计

### 4.1 语义驱动的 tab 策略（问题 1）

**核心原则：默认单 tab 顺序导航；多开 tab 仅当用户语义明确需要。**
（用户修正：不是机械地永远单 tab，而是按用户语义 / 任务目标判断；但一次对话
内的任务通常不复杂，基本单 tab 即可完成。）

- **判断依据 = 用户语义 / 任务目标**：
  - 任务最终目标是"到达某个页面 / 看到某个结果"（如"去百度搜 bilibili，去
    bilibili 打开慢学AI 的视频"——本质就是看那个视频），中间步骤（搜索、进
    站、找博主）都是**路径** → 默认单 tab，用 `page.goto` 在同一个 tab 顺序
    导航，不新开。
  - 用户语义明确需要多页时（"对比这两个页面"、"同时看多个"、需要保留参考
    页、或任务本身要并行操作）→ 才 `openOrReuseTab` 开新 tab，用完
    `closeTab`。
- **SKILL.md 修改**：
  - "Prefer `browser.openOrReuseTab(...)`" → "默认在当前 tab 用 `page.goto`
    顺序导航（目标导向）；`openOrReuseTab` 仅在用户语义明确需要多页时使用，
    新开 tab 用完即 `closeTab`"。
- **新增「导航后确认」规范**（根治"读新 tab 出错"）：
  - 每次导航后，先 `page.waitForURL(...)` 或轮询 `page.url()` 直到指向目标，
    再读取 / 操作；不轮询到就绪不读取。
  - 多开 tab 场景：`openOrReuseTab` → `listTabs` 找到目标 tab → `switchTab` →
    轮询 `page.url()` 确认 attach → 再操作。
- **任务收尾 tab 卫生**：任务结束（`complete` 前）`closeTab` 掉任务中开的
  临时 / 重试 tab，只保留最终结果页（`complete(id, { keep: true })`）。

### 4.2 临时脚本生命周期（问题 2）

- **默认位置**：临时操作脚本写 `$env:TEMP/ego-browser-<task>/`（**不进仓库**）。
- **任务收尾清单**（写入 SKILL「Operating principles」或新增小节）：
  1. 验证任务结果（证据）；
  2. `taskSpaces.complete(id, { keep: true|false })`；
  3. `closeTab` 清理任务中多余 tab；
  4. **删除临时脚本目录**（`$env:TEMP/ego-browser-<task>/`）；
  5. 产物（截图/下载）保留到仓库可见目录（如 `bilibili_task/` 或用户指定）。
- **本次遗留清理**：`bilibili_task/r1-r7.js` 按新规范删除，保留
  `final_video.png`（产物）。

### 4.3 learnings 后置沉淀（问题 3）—— 有必要，但要轻量

- 判断：**有必要**。本次"空间页顶部站方推广会误导取最近视频"这类坑很典型，
  不沉淀下次还会踩；且 learnings 机制已存在，成本低。
- **SKILL 增加「经验沉淀」后置步骤（可选）**：任务成功且验证后，agent 自主
  判断把新学到的站点经验写入 `learnings/<site>/`（notes/manifest/tools），
  不强制、不过度。
- **本次沉淀 `learnings/bilibili/`**：
  - `manifest.json`：domains = `bilibili.com`, `*.bilibili.com`；
    notes + 一个 nodeTool `get_recent_video`。
  - `notes/overview.md`：页面结构 + 关键坑：
    - **空间页顶部站方推广/「首页」导航会误导"取最近视频"** → 必须限定
      `bili-video-card` 投稿列表，忽略顶部推广（本次踩坑：取到官方"22和33"
      的 2233 生日曲）。
    - 中文输入/搜索用 `\uXXXX` 转义（PowerShell 管道编码坑）。
    - 投稿接口 `x/space/arc/search` / wbi 版限流（-799/-403）→ 用页面列表定位。
    - 新开 tab 后需轮询 `page.url()` 确认 attach 再读。
    - 验证视频归属用 `api.bilibili.com/x/web-interface/view`（返回
      owner.name / title / pubdate）。
  - `tools/get-recent-video.js`：输入空间 UID，返回最近发布视频的
    { bvid, title, pubdate, owner }（把本次踩坑后的正确逻辑固化成工具）。

### 4.4 明确不做（YAGNI）

- 不做运行时 `openOrReuseTab` 大改（先文档约束；仍不足再评估 B，登记
  PATCHES）。
- 不做自动 learnings 生成器（保持 agent 手动/可选）。
- 不动 handoff / cookie / 单实例（前两轮已修）逻辑。

## 5. 变更文件清单

| 文件 | 变更 |
|---|---|
| `docs/superpowers/specs/2026-08-16-ego-browser-tab-hygiene-and-learning-design.md` | 本文档（新） |
| `skills/ego-browser/SKILL.md` | 单 tab 顺序导航 + 导航确认规范 + 任务收尾清单 + 经验沉淀后置步骤 |
| `skills/ego-browser/references/operating-preferences.md` | tab 卫生 + 临时脚本清理规范 |
| `skills/ego-browser/references/task-spaces.md` | 收尾 complete/closeTab/清理示例 |
| `skills/ego-browser/learnings/bilibili/manifest.json` | 新增 bilibili 经验包 |
| `skills/ego-browser/learnings/bilibili/notes/overview.md` | 同上 |
| `skills/ego-browser/learnings/bilibili/tools/get-recent-video.js` | 同上 |
| `bilibili_task/` | 清理 `r1-r7.js`，保留 `final_video.png` |
| `runtime/skills/ego-browser/`、`.copilot/skills/ego-browser/`、`~/.copilot/skills/ego-browser/` | 同步 skill 改动 |

## 6. 验证

1. 复跑"百度→bilibili→慢学AI→最近视频"：期望 **tab 数显著减少（≤3）**、
   **无"读新 tab 出错"导致的重做**。
2. 临时脚本落在 `$env:TEMP/ego-browser-<task>/`，任务收尾自动清理；
   `bilibili_task/` 只剩产物。
3. `learnings/bilibili` 可被 `site.skills()` 加载；`get_recent_video` 工具可用。
4. 三份 skill 副本（canonical / runtime / 已安装）一致。
