# ego-lite-windows — 独立可用的 Windows 版 ego-lite

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) 的能力移植到
**Windows**：一个自包含仓库，内含 **Windows 可用的 ego-lite 运行时**（社区
Linux 移植，经 CDP 驱动你本机的 Edge/Chrome）+ **GitHub Copilot 技能**。

官方 ego-lite 仅支持 macOS；本仓库内置的 `runtime/ego-linux` 是社区 Linux
移植（PR #234），用**普通 Chrome/Edge** 代替 macOS App，因此天然支持
Windows —— 无需 DSH、无需购买、无需构建。

## 它是什么 / 不是什么

- ✅ 一个**已编译、已验证**的浏览器自动化运行时（heredoc JS → 驱动真实浏览器）
- ✅ 一份让 **Copilot 会用它的 SKILL.md**（开网页、抓数据、填表、截图、测试…）
- ✅ 自动探测 Chrome/Edge/Brave、处理 Windows 路径坑位的启动器
- ❌ 不是对官方 macOS App 的重写，也不是全新浏览器——它是现成 Linux 移植的打包

## 快速开始

```powershell
# 1. 冒烟验证（无头 Edge/Chrome，开 example.com，读页面信息）
node scripts\verify.mjs

# 2. 手动跑一段浏览器脚本
$script = @'
const task = await taskSpaces.useOrCreate('demo')
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 30 })
console.log(await page.snapshot())
await taskSpaces.complete(task.id, { keep: false })
'@
$script | ego-browser nodejs

# 3. 停止共享浏览器
ego-browser --stop
```

## 推荐用法（打开→操作）

- **首启直达**：`ego-browser --url https://example.com`（或 `ego-browser https://example.com`）— 第一个窗口就是目标页，无空白页。
- **全程复用**：一个目标一个长驻浏览器，任务（含验证码 handoff）都复用同一窗口，不要反复 `--stop` 重启。
- **遇验证码/登录**：浏览器停在页面不关闭，用户完成后 agent 用 `takeOver` 继续。
- **稳定喂脚本**：把脚本写到 `.js` 文件，PowerShell 用 `Get-Content file -Raw | ego-browser nodejs`，cmd 用 `ego-browser nodejs < file`。

## 让 Copilot 使用

```powershell
node scripts\verify.mjs                      # 先确认运行时可用
powershell -ExecutionPolicy Bypass -File scripts\install-copilot-skill.ps1
# 然后：VS Code 里 "Developer: Reload Window"
```

装好后在 Copilot Chat 里直接说"打开 example.com 抓一下内容"，Copilot 会读取
`SKILL.md` 并自动驱动浏览器。详细步骤见 [install.md](install.md)。

## 目录结构

```
ego-lite-windows/
├── runtime/                    # vendored 运行时（只读参照，改动见 runtime/PATCHES.md）
│   ├── ego-linux/              #   CDP shim + 启动器（bin/ego-browser.mjs + src/）
│   ├── ego-browser/dist/out/   #   已编译 harness（helper 注入器）
│   └── PATCHES.md              #   相对上游的本地改动记录
├── skills/ego-browser/         # 权威 skill 包（SKILL.md + references + learnings）
│   ├── SKILL.md                #   Copilot 读取的主文档（对准实际 facade）
│   ├── references/             #   facade / task-spaces / windows / install / video
│   ├── learnings/              #   google、x-com 等站点经验包
│   └── scripts/install.ps1     #   skill 安装器
├── scripts/
│   ├── ego-browser-launch.mjs  # ★ Windows 启动器：找浏览器 + 正斜杠路径 + env 转发
│   ├── verify.mjs              #   冒烟测试
│   └── install-copilot-skill.ps1  # 装到 ~/.copilot/skills/ego-browser
├── bin/ego-browser.cmd         # 可加 PATH 的 ego-browser 命令
└── .copilot/skills/ego-browser/SKILL.md  # 仓库内项目级 Copilot 技能副本
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `ego-browser`（`bin\ego-browser.cmd`） | 唯一命令入口（`bin\` 需在 PATH）；转发到下方启动器 |
| `scripts/ego-browser-launch.mjs` | 启动器实现：自动探测 Edge/Chrome/Brave，把路径转成正斜杠（运行时要求），设 `EGO_LINUX_HEADLESS` / `EGO_BROWSER_AGENT_WORKSPACE`，转发 stdin + 参数 |
| `skills/ego-browser/SKILL.md` | 教 Copilot 怎么驱动浏览器（实际 facade：`page/browser/taskSpaces/site/fetch/cdp/help`） |
| `skills/ego-browser/references/facade.md` | facade 完整参考（方法清单） |

## 常用命令

| 命令 | 说明 |
|---|---|
| `ego-browser nodejs` | 跑 stdin heredoc（PATH 上的命令） |
| `ego-browser --headless nodejs` | 无头运行 |
| `ego-browser --url <url>` | 首启直达：冷启动直接打开目标页（无空白页） |
| `ego-browser --status` / `--open` / `--stop` | 状态 / 显示窗口 / 停止 |
| `ego-browser --import-chrome-profile` | 继承真实 Chrome 登录态 |
| `node scripts/verify.mjs` | 端到端冒烟测试 |
| `node scripts/verify-single-instance.mjs` | 单实例回归（多开检查） |

## 环境变量

`EGO_LINUX_CHROME`（浏览器路径，正斜杠）、`EGO_LINUX_HEADLESS`（`1`=无头）、
`EGO_BROWSER_AGENT_WORKSPACE`（skill 工作区，默认 `skills/ego-browser`）、
`EGO_LINUX_PROXY`。

## PATH 配置

要让 `ego-browser` 在任意目录可用，把下面这个目录加入 `PATH`：

`c:\Users\quincy\workspace\mywork\fontwebProjects\ego-lite-windows\bin`

不要把 `scripts\` 当成命令入口；它只是启动器所在目录。

## 已知限制（诚实说明）

- 快照质量：Linux 移植用 CDP `DOMSnapshot` 重建语义树，复杂 iframe/canvas 可能不如 macOS 内核级
- 稳定性：社区移植，复杂多步流程可能需要重试（运行时内置冷启动重试）
- 无官方 UI：默认可见的 agent 窗口，但没有官方 App 的多窗口/面板
- 登录态：Chrome 运行期 Cookie 仅优雅关闭（`--stop`/正常退出）时落盘；space 内登录的 Cookie 会在 space 关闭或 `--stop` 时自动回流到共享 profile，下次会话自动继承

## 许可与来源

- 插件本体 MIT（见 [LICENSE](LICENSE)）
- 运行时 vendored 自 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（MIT），
  含 Linux 移植 PR #234 及本地改动（见 [runtime/PATCHES.md](runtime/PATCHES.md)）
- 移植来源：`ego-browser` DSH 插件仓库的 `runtime/`（详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）
