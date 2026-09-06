# 安装与接入（ego-lite-windows）

本仓库自包含：运行时已 vendored，无需下载、无需构建、无需 DSH。下面是从零
到"Copilot 能驱动浏览器"的完整步骤。

## 0. 前置条件

- **Node >= 22**：`node --version`
- **Chrome / Edge / Brave**：任一（启动器会自动探测）

## 1. 验证运行时（必做）

```cmd
cd <repo>
node scripts\verify.mjs
:: 期望输出：PASS: runtime drives a real page on this machine
```

这会无头启动 Edge/Chrome、打开 example.com、读取页面信息、关闭任务空间。
首次冷启动较慢（~20s）属正常。

## 2. 接入 GitHub Copilot（一次性安装 ego-browser skill）

```cmd
scripts\install-copilot-skill.cmd
```

一次完成：

- 把 `skills/ego-browser/` 复制到 `~\.copilot\skills\ego-browser\`（浏览器自动化 skill）
- 把 `bin\` 加入用户 PATH → `ego-browser` 全局可用

在 VS Code 执行 `Developer: Reload Window`（或重启）。

> 可选：仓库内已带 `.copilot/skills/ego-browser/SKILL.md`（项目级副本），
> 只在本仓库内使用也无需上面那步。

## 3. 确认 skill 生效

在 Copilot Chat 输入 `/`——应能看到 `ego-browser` 斜杠命令；或直接说
"用浏览器打开 example.com" / "抓取这个页面"，Copilot 会自动加载 skill 并运行
`node scripts/ego-browser-launch.mjs nodejs` heredoc。

## 4.（可选）让 `ego-browser` 命令全局可用

把 `bin\` 加入用户 PATH：

```cmd
:: 用安装器最省事（幂等加 PATH）：
scripts\install-copilot-skill.cmd

:: 或手动加（重开终端后生效）：
setx Path "%PATH%;<repo>\bin"
```

## 5.（可选）继承真实登录态

```cmd
node scripts\ego-browser-launch.mjs --stop
node scripts\ego-browser-launch.mjs --import-chrome-profile
```

## 移植到新电脑（Porting）

把整个 `ego-lite-windows` 文件夹拷贝到新电脑即可，**无需构建、无需 npm install、无需 DSH**。

```cmd
:: 1. 拷贝整个仓库文件夹到新电脑（含 runtime/、skills/、scripts/、bin/）
:: 2. 装 Node >= 22
:: 3. 确认有 Chrome / Edge / Brave（或设 EGO_LINUX_CHROME）
:: 4. 冒烟验证：
node scripts\verify.mjs
:: 5. 装 Copilot 技能（可选）：一次性安装 ego-browser skill
scripts\install-copilot-skill.cmd
::    然后 VS Code 里 Reload Window
:: 6. 需要登录的站点：--open 登录一次 → --stop 落盘（见 operating-preferences）
```

> 依赖只有：**Node ≥ 22** + **任一 Chrome/Edge/Brave**。登录态/状态数据按机器独立，
> 新机器需重新登录一次（各机器 profile 在各自 `~/.local/share/ego-lite-linux`）。

## 常见问题

| 现象 | 处理 |
|---|---|
| `no Chrome/Chromium binary found` | 设 `EGO_LINUX_CHROME` 为**正斜杠**绝对路径，或装 Edge/Chrome |
| `xxx is not defined` | 用了上游新版 helper 名；本运行时暴露 **facade**（`taskSpaces/page/browser/...`），看 `skills/ego-browser/references/facade.md` |
| Copilot 里没有出现技能 | 确认已 Reload Window；检查 `~\.copilot\skills\ego-browser\SKILL.md` 存在 |
| 页面弹对话框卡住 | `page.info()` 返回 `{dialog}` 时，先 `await cdp('Page.handleJavaScriptDialog', { accept: true })` |
| 不想弹窗口 | heredoc 前加 `--headless`，或 `EGO_LINUX_HEADLESS=1` |

更多见 `skills/ego-browser/references/windows.md`。
