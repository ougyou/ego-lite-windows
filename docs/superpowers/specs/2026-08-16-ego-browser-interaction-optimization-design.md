# ego-browser 交互优化设计（2026-08-16）

状态：待用户审查（brainstorming 阶段，未实现）

## 1. 背景与问题

用户在实际使用（打开百度 → 搜索哔哩哔哩 → 点击进入 bilibili）中反馈三个痛点，加上一次实测暴露的流程问题：

1. **卡安全验证时流程被“关闭”而不是“停留交接”**
   - 实测：打开百度搜索时，百度把请求重定向到安全验证页（`wappass.baidu.com/.../captcha/...`），且打开该页后浏览器 CDP 连接断开（`browser connection closed`）。
   - 我上轮的处理：`--stop` 关掉浏览器，结束流程，让用户自己去开。❌
   - 用户期望：**浏览器停在验证码页不关闭**，用户操作完成后确认，agent 用 `takeOver` 继续原任务。
   - 根因：`handOff/takeOver` 机制早已存在（`references/task-spaces.md`），但主文档 `SKILL.md` 的“人工介入 SOP”不够可操作，且执行时没落实。

2. **每次操作仍打开空白浏览器进程，且未复用**
   - 根因：agent 执行任务不一定带 `--url`，冷启动默认 `about:blank`；上轮测试反复 `--stop` 再冷启动，制造多个浏览器窗口/进程。
   - 期望：首启直达目标页（无空白页），全程复用同一个长驻浏览器，绝不因流程重启浏览器。

3. **流程往返过长，简单任务消耗时间多**
   - 根因：终端在 cmd/PowerShell 间切换导致 heredoc 语法失效；编码写错；遇验证码关掉重来；反复冷启动。
   - 期望：更原子化的脚本、shell 无关的稳定执行方式、遇人工步骤即 handoff（不重试）。

## 2. 目标

- 消除空白浏览器窗口 / 多开进程。
- 人工步骤（验证码/登录/SSO）正确 handoff：停页面 → 等用户完成 → 继续，绝不关闭结束。
- 大幅压缩“打开→搜索→点击→验证”类任务的往返次数与耗时。

## 3. 方案对比

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A. 仅文档/技能强约束** | 在 SKILL.md / operating-preferences / task-spaces 里写明“首启直达 + 全程复用 + handoff SOP”，要求 agent 遵守 | 零代码、改动小、立即可用 | 依赖 agent 自觉；脚本执行方式（heredoc）仍不稳 |
| **B. A + 稳定脚本执行方式（推荐）** | A 的全部 + 文档固化“写文件 → stdin 重定向”的 shell 无关执行方式，并给原子化流程模板 | 解决往返与终端差异两大痛点，改动集中在文档/技能 | 需要用户/agent 习惯新执行方式 |
| **C. B + 运行时自动检测** | B 的全部 + 新增 helper：按 URL 特征（captcha/wappass/login/sso…）自动识别人工介入并提示 handoff | 最省心，检测不靠肉眼 | 需改运行时，成本高、收益边际 |

**推荐 B**：A 的约束 + 稳定执行方式，不引入过度机制（YAGNI）。C 的自动检测留作后续可选。

## 4. 设计（方案 B）

### 4.1 启动与复用规范（消除空白页/多开）

- **任务默认首启直达**：agent 执行浏览器任务一律用
  `ego-browser --url <目标页> [nodejs]` 或 `ego-browser <目标页>` 启动，
  第一个窗口就是目标页，**不出现 `about:blank` 空白窗口**。
  （`--url` 首启直达已实现并验证：`TAB_COUNT=1`、`TAB_URLS=目标页`。）
- **全程复用**：一个用户目标 = 一个 task space = 一个长驻浏览器。整个任务（含多次 heredoc 往返、含 handoff 前后的 takeOver）复用同一浏览器与窗口；**除非用户明确要求，绝不 `--stop` 重启浏览器**。
- **收尾**：任务真正结束才考虑 `complete(keep:...)`；需用户查看结果时用 `complete(id, { keep: true })` 保留目标页，并顺手 `closeTab` 清掉中间产生的 scratch tab。

### 4.2 人工介入 SOP（验证码/登录/SSO handoff）

遇到人工步骤时，按以下固定流程，**严禁关闭浏览器结束**：

1. **检测**：页面被重定向到验证码/登录页（URL 含 `captcha`、`wappass`、`login`、`sso`、`passport`、`verify` 等），或出现登录表单/滑块验证。
2. **停在页面**：不要导航走，让浏览器窗口停在当前页。
3. **handoff**：`await taskSpaces.handOff(task.id)` 把控制权交给用户。
4. **告知**：用一句话告诉用户“请在浏览器窗口完成滑块验证/登录，完成后回复‘好了/继续’”。
5. **等确认**：不做任何自动化重试（验证码等无法安全自动处理）。
6. **继续**：用户确认后，新 heredoc 以 `await taskSpaces.takeOver(task.id)` 拿回控制，继续原任务（复用同一 space/浏览器）。

例外：若用户回复“不用继续了/算了”，才按正常收尾 `complete`。

### 4.3 稳定脚本执行（压缩往返）

- **shell 无关的喂脚本方式**（文档固化，避开 PowerShell/cmd heredoc 差异）：
  - 把脚本写入一个临时 `.js` 文件（UTF-8）。
  - PowerShell：`Get-Content file.js -Raw | ego-browser nodejs`
  - cmd：`ego-browser nodejs < file.js`
- **原子化流程模板**：把“打开→搜索→点击→验证”写成单个健壮 heredoc/脚本，
  减少多次往返；一次任务理想 ≤ 3 次脚本调用（启动/操作、handoff 后继续、收尾）。
- **agent 执行原则**：全程一个 space；每步有明确输出；遇人工步骤立即 handoff 而不是重试或关闭。

### 4.4 后续可选（本期不做）

- 自动识别“人工介入页”的 helper（方案 C），减少肉眼判断。

## 5. 边界

- **不做**：自动破解/绕过验证码；改动运行时核心逻辑；新增浏览器进程管理机制。
- **已有且保留**：`--url` 首启直达、space cookies 回流默认 jar（登录态跨会话持久，已实现并验证）。

## 6. 变更文件清单

| 文件 | 变更 |
|---|---|
| `skills/ego-browser/SKILL.md` | 新增“启动与复用”“人工介入 SOP”“稳定执行”三个可操作章节 |
| `skills/ego-browser/references/operating-preferences.md` | 补充：遇人工步骤停页面 handoff、禁止关闭结束、禁止无谓 --stop 重启 |
| `skills/ego-browser/references/task-spaces.md` | 明确 handoff 后“等用户确认再 takeOver 继续原任务”的 SOP 落地示例 |
| `skills/ego-browser/references/windows.md` | 固化 shell 无关的喂脚本方式（Get-Content / < 重定向） |
| `README.md` | 使用说明同步 |

## 7. 测试 / 验证

1. `node scripts/verify.mjs` 冒烟仍 PASS。
2. `ego-browser --url <目标>` 首启直达：单标签、无空白页。
3. **handoff 流程验证**：构造人工介入场景 → 停在页面 → `handOff` → 用户完成 → `takeOver` 继续，全程同一浏览器/窗口。
4. 真实流程（百度→bilibili）：需用户配合过一次百度验证码；此后登录态持久，不再被拦。

## 8. 验收标准

- [ ] 任务启动不再出现空白浏览器窗口。
- [ ] 整个任务（含 handoff 往返）始终是同一个浏览器/窗口。
- [ ] 遇验证码时浏览器停在页面并 handoff，用户完成后 agent 继续原任务。
- [ ] “打开→搜索→点击”类任务脚本调用次数明显减少。
