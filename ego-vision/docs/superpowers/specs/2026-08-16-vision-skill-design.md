# 独立视觉理解 skill（vision）设计（2026-08-16）

状态：用户已确认方向（独立 skill + 三点修订：工作区子目录 / ego-browser 可选声明 / 安装一并）。
未实现。

> 位置：`ego-lite-windows/vision/`（**当前工作区子目录**，自包含，不混入 ego-lite 运行时/skill 内部）。
> 本文取代 `docs/superpowers/specs/2026-08-16-ego-browser-local-ocr-design.md`（「嵌入浏览器」方案，已废弃）。

## 1. 背景与问题

原方案把本地 OCR 嵌入 ego-browser 的浏览器 harness（给编译产物 `dist/out/index.js` 打补丁注入
`page.ocr`）。用户转向：**视觉理解不该绑死在浏览器自动化里**，应做成独立能力，浏览器只是其中一个消费者。

独立化的硬理由：

1. **单一职责**：视觉理解是独立能力，可复用于截图、本地图片、扫描件、文档、游戏画面等任意场景。
2. **复用面广**：不只浏览器操作用得上。
3. **绕开最危险的部分**：不再给编译产物 harness 打补丁（原方案风险最高处）。

**核心驱动力不变**：成本。视觉模型昂贵，大部分时候用不到。分层视觉：
本地离线 OCR（廉价、高调用量）为主通道 → 视觉模型（高精度/理解，按需）为升级通道。

### 用户三点修订（2026-08-16）

1. **位置**：在当前工作区下新建子文件夹 `vision/` 放置全部 vision 内容；环境变量用独立命名空间，不与 ego-lite 糅合。
2. **声明**：在 ego-browser skill 中加一条「可选使用 vision 能力」的轻声明，**不做强制**。
3. **安装**：`install.md` 与安装脚本**一并安装两个 skill + vision 能力**。

## 2. 目标

- 独立、自包含的「视觉理解」能力，v1 交付 **OCR**：任意本地图片 → 文本 + 坐标（可定位/可点击）。
- 本地 OCR 层**彻底离线**（模型 + 依赖 vendored 提交，运行期零网络、零 API key）。
- 引擎**可插拔**（`EGO_VISION_ENGINE`）；视觉模型升级通道以文档给出。
- 位于工作区子目录 `vision/`，**不混入** ego-lite 运行时/skill 内部。
- ego-browser skill 仅作**可选**声明；`install.md`/安装脚本一并安装两个 skill + 能力。

## 3. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | v1 范围 = OCR（文本+坐标）；布局/语义理解留 v2 | 与既定成本策略一致；先做稳最小核心 |
| D2 | 全部 vision 内容放**当前工作区子目录 `vision/`**（自包含）；skill 包在 `vision/skill/` | 用户要求 1：不糅合进 ego-lite |
| D3 | CLI 命名 `ego-vision`（子命令 `ocr`） | 与 ego-browser 命名一致；为后续能力留扩展位 |
| D4 | 浏览器侧 v1 **不打 harness 补丁**；`page.screenshot({path})` → `ego-vision ocr` | 绕开最危险环节；浏览器只是消费者 |
| D5 | 本地层彻底离线：tesseract.js + pngjs + traineddata **vendored 提交**（依赖也打包） | 沿用用户「彻底离线 + 依赖也打包」的明确选择 |
| D6 | 语言包用 **standard tessdata**（eng + chi_sim ≈ 22MB） | 中文质量优于 fast，体积优于 best；在预算内 |
| D7 | 坐标返回**图像像素空间**；浏览器使用时由调用方按已知 scale 换算 | CLI 面对任意图片，无法预知 CSS/视口映射 |
| D8 | 一次性 setup（npm install + 下载 traineddata）需联网，**实施时须用户同意** | 运行期零网络；setup 联网是显式一次性动作 |
| D9 | vision 用独立环境变量命名空间 **`EGO_VISION_*`**，不与 ego-lite 的 `EGO_LINUX_*`/`EGO_BROWSER_*` 混用 | 用户要求 1：环境变量另外配置 |
| D10 | ego-browser skill 只加「可选视觉能力」**轻声明，不强制** | 用户要求 2 |
| D11 | `install.md` 与 `scripts/install-copilot-skill.ps1` **一并**安装 ego-browser skill、vision skill、并把 `vision\bin` 加入 PATH | 用户要求 3 |

## 4. 方案对比（独立化形态）

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A. 自包含工具 + skill 包（推荐）** | 工作区子目录 `vision/`：`ego-vision` CLI + `vision/skill/` SKILL.md；主安装脚本一并安装 | 可复用、可单测、跨场景；浏览器/文档/游戏都能调 | 新子项目骨架 |
| **B. 纯 skill（只写文档）** | 只写 SKILL.md，教 agent 用系统/现成 OCR 工具 | 零代码 | 依赖环境有现成 OCR；不彻底离线、不稳定 |
| **C. 浏览器插件形态** | 继续嵌 harness，仅把文档抽成独立 skill | 改动小 | 违背「不嵌入」；仍绑死浏览器 |

**推荐 A**：自包含、可复用、可测试，符合用户「独立」意图与三点修订。

## 5. 设计（方案 A）

### 5.1 架构与组件

```
ego-lite-windows/
├── vision/                          # 所有 vision 内容（自包含，不糅合进 ego-lite）
│   ├── skill/                       # vision Copilot skill 包
│   │   ├── SKILL.md
│   │   └── references/  cli.md · tiered-vision.md · browser-use.md
│   ├── bin/ego-vision.cmd           # Windows PATH 包装
│   ├── cli/ego-vision.mjs           # Node CLI：`ego-vision ocr <image> [opts]`
│   ├── src/ocr/
│   │   ├── index.mjs                # 公共 API：recognize(image, opts)
│   │   ├── registry.mjs             # 引擎注册表（EGO_VISION_ENGINE 切换）
│   │   ├── image.mjs                # pngjs 裁剪/放大
│   │   └── engines/tesseract.mjs    # 本地离线引擎（默认）
│   ├── data/                        # vendored：eng.traineddata + chi_sim.traineddata（~22MB）
│   ├── node_modules/                # vendored：tesseract.js + pngjs（提交）
│   ├── package.json + package-lock.json
│   ├── scripts/  make-fixture.ps1 · test-ocr-engine.mjs · test-cli.mjs · verify-ocr.mjs
│   └── docs/superpowers/            # 本设计文档 + 实现计划
├── skills/ego-browser/              # 现有（将加一条可选声明，Task 5）
└── install.md                       # 更新：一并安装两个 skill + 能力（Task 6）
```

### 5.2 CLI 接口

```
ego-vision ocr <image> [--langs eng+chi_sim] [--engine tesseract]
                     [--min-confidence 0.5] [--region x,y,w,h] [--scale 2] [--find <子串>]
```

stdout 输出 JSON（`--find` 时附带命中行，便于直接定位/点击）：

```json
{
  "engine": "tesseract",
  "width": 1280, "height": 800,
  "text": "…（按行拼接）…",
  "lines": [
    { "text": "…", "confidence": 0.92,
      "bbox": { "x": 10, "y": 20, "w": 200, "h": 30 },
      "center": { "x": 110, "y": 35 } }
  ],
  "found": { "text": "…", "confidence": 0.9, "bbox": {…}, "center": {…} }  // 仅 --find 命中时
}
```

- **坐标 = 图像像素空间**（任意图片通用约定）；浏览器使用时按
  `scaleFactor = imageWidth / 视口CSS宽度` 换算。
- `--region` 为图像像素裁剪（加快、聚焦）；`--scale` 本地引擎放大小字用（坐标映射回原图）。

### 5.3 数据流

```mermaid
flowchart LR
    A[agent / CLI 调用] --> B[读图片文件 → Buffer]
    B --> C{--region?}
    C -->|是| D[裁剪子图]
    C -->|否| E[整图]
    D --> F{--scale>1?}
    E --> F
    F -->|是| G[放大]
    F -->|否| H[原图]
    G --> I[选引擎: registry[EGO_VISION_ENGINE]]
    H --> I
    I --> J[本地 tesseract 引擎]
    J --> K[lines + bbox（当前图像素）]
    K --> L[坐标映射回原图 + 置信度过滤 + --find]
    L --> M[stdout JSON]
```

### 5.4 分层视觉策略（tiered-vision）

- **默认本地 OCR**（`tesseract`，离线、免费、快）：读文字、定位点击——高调用量主通道。
- **升级通道（按需、显式选择）**：高精度识别 / 布局与语义理解 / OCR 低置信度 →
  用 agent 自身具备的**视觉模型**处理图片（skill 文档给出模式）。
- **安全边界**：页面正常展示的文字（验证码/票号等）读取 OK；**不用于绕过安全验证码**
  （wappass/滑块/reCAPTCHA 等仍走 handoff）。

### 5.5 离线、依赖、环境变量

- tesseract.js（固定版本 `5.1.1`）+ pngjs（`7.0.0`）+ standard tessdata（eng、chi_sim）**全部 vendored 提交**。
- `vision/.gitignore` 中 **不忽略** `node_modules/`（vendored 依赖必须入库）。
- **运行期零网络**；setup 联网（npm install + 下载语言包）为一次性显式动作，实施时须用户同意。
- **环境变量独立命名空间**：`EGO_VISION_LANGS` / `EGO_VISION_ENGINE` / `EGO_VISION_DATA_DIR`，
  与 ego-lite 的 `EGO_LINUX_*` / `EGO_BROWSER_*` 完全分开，互不糅合。
- 许可证登记：tesseract.js（Apache-2.0）、tesseract.js-core（Apache-2.0）、pngjs（MIT）、tessdata（Apache-2.0）。

### 5.6 与 ego-browser 的关系（用户要求 2：可选声明，不强制）

- ego-browser skill（`skills/ego-browser/SKILL.md`）只加一条**轻声明**：需要从截图/图片读取文字
  时可选用 vision skill（`ego-vision ocr`），**默认仍用 `page.snapshot()` 语义树**。
- 消费者模式（v1，不打 harness 补丁）：
  `page.screenshot({ path })` → `ego-vision ocr <path>` → 按 scale 换算坐标后点击。
- 不强制：无 vision skill 时浏览器能力完全不受影响。

### 5.7 安装集成（用户要求 3：一并安装）

- 主安装脚本 `scripts/install-copilot-skill.ps1` 扩展为**一并**：
  1. 复制 `skills/ego-browser/` → `~\.copilot\skills\ego-browser\`
  2. 复制 `vision/skill/` → `~\.copilot\skills\vision\`
  3. 把 `bin\`（ego-browser）与 `vision\bin\`（ego-vision）加入用户 PATH
  4. 校验 vision 的 vendored 依赖/数据齐全（离线可跑；缺失则警告先跑 setup）
- `install.md` 更新：说明一次安装拿到两个 skill + 能力；移植章节包含 `vision/` 子目录。
- 全部 vendored，**安装无需网络**。

## 6. 错误处理与降级

| 情况 | 处理 |
|---|---|
| 引擎/数据缺失 | 清晰报错，提示确认 vendored 数据完整（无网络获取） |
| 引擎运行时失败 | 自动重试 1 次，仍败则报错 |
| 低置信度 | 结果带 `confidence`，`--min-confidence` 过滤（默认 0.5） |
| 超时 | 有界等待（默认 15s），超时返回已得部分结果 |
| 图片不可读/格式不支持 | 清晰报错 |
| OCR 置信度过低 | 文档指引：升级到视觉模型通道 |

## 7. 边界（本期不做）

- 布局 / 语义理解、元素检测 → v2（视觉模型）。
- 高精度本地引擎（RapidOCR/Paddle）→ 引擎接口已预留。
- PDF / 视频逐帧 → 后续。
- ego-browser 的 `page.ocr` 内嵌 helper → v2 可选（届时再评估是否碰 harness）。
- vision skill 不接入浏览器也完全可用（独立性保证）。

## 8. 变更文件清单

| 文件 | 变更 |
|---|---|
| `vision/package.json` + `package-lock.json` | 新增：固定 tesseract.js / pngjs 版本 |
| `vision/.gitignore` | 新增：不忽略 node_modules（vendored 入库） |
| `vision/THIRD_PARTY_NOTICES.md` | 新增：许可证登记 |
| `vision/bin/ego-vision.cmd` | 新增：PATH 包装 |
| `vision/cli/ego-vision.mjs` | 新增：CLI |
| `vision/src/ocr/index.mjs` | 新增：公共 API |
| `vision/src/ocr/registry.mjs` | 新增：引擎注册表 |
| `vision/src/ocr/image.mjs` | 新增：pngjs 裁剪/放大 |
| `vision/src/ocr/engines/tesseract.mjs` | 新增：Tesseract.js 适配器 |
| `vision/data/` | 新增：`eng.traineddata` + `chi_sim.traineddata`（vendored） |
| `vision/node_modules/` | 新增：tesseract.js + pngjs + 依赖（vendored） |
| `vision/scripts/make-fixture.ps1` | 新增：System.Drawing 渲染中英文测试图 |
| `vision/scripts/test-ocr-engine.mjs` | 新增：引擎单元测试 |
| `vision/scripts/test-cli.mjs` | 新增：CLI 契约测试 |
| `vision/scripts/verify-ocr.mjs` | 新增：冒烟测试 |
| `vision/skill/SKILL.md` | 新增：vision skill 主文档 |
| `vision/skill/references/cli.md` | 新增：CLI 参考 |
| `vision/skill/references/tiered-vision.md` | 新增：分层视觉策略 |
| `vision/skill/references/browser-use.md` | 新增：浏览器消费模式 |
| `vision/docs/superpowers/specs/…design.md` | 本设计文档 |
| `vision/docs/superpowers/plans/…plan.md` | 实现计划 |
| `skills/ego-browser/SKILL.md` | 修改：加「可选视觉能力」轻声明（Task 5） |
| `scripts/install-copilot-skill.ps1` | 修改：一并安装两个 skill + vision\bin 入 PATH（Task 6） |
| `install.md` | 修改：安装说明更新（Task 6） |
| `docs/superpowers/specs/2026-08-16-ego-browser-local-ocr-design.md` | 修改：标记「已被独立 vision skill 取代」（已改） |

## 9. 测试 / 验证

1. **单元**：tesseract 适配器对 `make-fixture.ps1` 生成的中英文夹具图断言识别文本与坐标。
2. **CLI 契约**：`ego-vision ocr` 输出 JSON 结构断言（`lines[].center` 存在等）。
3. **冒烟**：`node scripts/verify-ocr.mjs` 全链路 PASS（fixture → CLI → 断言）。
4. **区域/--find**：`--region` 只识别指定区域；`--find` 命中并给出可点击 `center`。
5. **安装回归**：`install-copilot-skill.ps1` 装两个 skill + 两个 bin 入 PATH（`-SkipPath` 可跳过）。

## 10. 验收标准

- [ ] `ego-vision ocr <图片>` 对中英文图片返回文本 + 坐标（图像像素）。
- [ ] 运行期零网络完成 OCR（彻底离线）。
- [ ] `--region` / `--find` / `--min-confidence` / `--scale` 生效。
- [ ] 引擎可插拔（`EGO_VISION_ENGINE` / `--engine`）。
- [ ] `node scripts/verify-ocr.mjs` PASS。
- [ ] vision 全部内容在工作区子目录 `vision/`，环境变量用 `EGO_VISION_*`，不与 ego-lite 糅合。
- [ ] ego-browser skill 含「可选视觉能力」轻声明，且不强制。
- [ ] `install.md` / 安装脚本**一并**安装两个 skill 与能力（`ego-vision` 可用）。
