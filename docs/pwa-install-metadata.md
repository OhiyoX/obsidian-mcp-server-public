# Web 安装元数据（#471 P1）

> **状态：candidate**（分支已提交，未合并 / 未 tag / 未部署）。本文只描述 **P1**：可安装**元数据**。
> **没有 Service Worker**（`/app/sw.js`、预缓存、更新提示、离线页都属 **P2**，见 `docs/QUALITY_AUDIT.md` 与 Vault 的 `DEVELOPMENT - Issue 471 …`）。跟踪 [#471](https://github.com/OhiyoX/obsidian-mcp-server/issues/471)。

## 1. 这一刀落什么

| 面 | 实现 | 位置 |
| --- | --- | --- |
| Manifest | `/app/assets/manifest.webmanifest`，`id` / `start_url` / `scope` **同为 `/app/`** | `app/src/app/assets/manifest.webmanifest`（由 `scripts/make-pwa-icons.mjs` 生成） |
| 图标 | `icon-192.png`、`icon-512.png`（透明，`purpose: any`）、`icon-maskable-512.png`（不透明满幅，图形在安全区内）、`apple-touch-icon-180.png` | 同上 |
| app 壳 head | `rel=manifest`、`rel=apple-touch-icon`、`apple-mobile-web-app-capable` / `-status-bar-style` / `-title` | `app/src/app/pages.js` 的 `appPage()`（`/app`、`/app/note/*`、`/app/base/*` **共用**） |
| CSP | 共享 Web 策略**最小**增加 `manifest-src 'self'` | `app/src/app/routes.js` `applySecurityHeaders()` |

**不做**（边界）：不动 `/app/assets/*` 的 `immutable` 语义与 `/app`、`/auth`、`/api/web/*`、`/publish` 的 `no-store` 口径；不给 Publish 挂 manifest（其 CSP 独立）；不新增第二个 `theme-color` 写者（沿用 `theme-boot.js`）；`worker-src` 留 P2。

## 2. 关键决策与理由

- **`id` / `start_url` / `scope` = `/app/`**：`start_url: "/app"` 不在 `scope: "/app/"` 内，会触发 **scope 回落**（R5 订正）；仓库已有 `/app/` 路由，三者统一。
- **资产走既有管线 + 内容寻址**：manifest 与图标都由 `assetUrl()` 生成 `?v=<sha256[:16]>`，与 `#414` 的 `immutable` 策略一致 —— 换了图标不会等一年才被取回。manifest 内部的图标 URL 由生成器写入同样的 `?v=`，`test/web-pwa-install-metadata.test.js` 会校验它与文件内容一致（防止「改了 PNG 忘了重生成」）。
- **`black-translucent` 不是声明即安全**：它让内容延伸到状态栏之下，因此必须有真实的 top-inset owner。app 壳（`#371`）已把 `env(safe-area-inset-top)` 收敛为**单一** `--app-inset-top` owner（`app.css` 的 `≤720px` 表），浏览器门禁的 `pwa:` 检查会在注入非零 inset 后实测 topbar 高度精确增长、tab 行不重复补。
- **登录页**：继承共享 CSP 的 `manifest-src` 许可，但**不挂 manifest**（R5 允许、不要求）；**Publish 页**保持独立 CSP 与独立 head。

## 3. 图标生成（可复现）

- 源：`app/src/app/assets/favicon.svg`（512×512 viewBox，无底色）。
- 命令（在 `app/`）：`node scripts/make-pwa-icons.mjs` —— 用 **Playwright + 与浏览器门禁同一枚 pinned 全量 Chromium**（`scripts/web-regression/chromium-binary.mjs`，拒绝 headless-shell；`PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE` / `PLAYWRIGHT_BROWSERS_PATH` 同口径）。
- maskable / Apple 的画幅缩放是**量出来的**：脚本先渲染 512×512、读 alpha 通道求图形最远像素半径，再取「全部墨迹仍在 maskable 安全圆（半径 = 40% 边长）内、留 2% 余量」的最大缩放；本次测量见 `P471/HANDOFF.md`。
- CI 的 `git diff --exit-code -- app/src/app/assets` 只证明 `build:web` 没改资产；**PNG ↔ manifest 的同步**由 Node 门禁（`?v=` 与文件内容比对）保证。

## 4. 门禁

| 门禁 | 覆盖 |
| --- | --- |
| `app/test/web-pwa-install-metadata.test.js` | 真实 HTTP 的 head（app / note / Base 共用、登录页无 manifest、Publish CSP 独立）、manifest MIME/`immutable`/字段、图标**实际像素尺寸**、maskable **逐像素安全区**、`?v=` 内容寻址 |
| `Chromium web regression` 的 `pwa:` 检查（`app/scripts/web-regression/pwa-install.mjs`） | Chromium **实际取回并解析** manifest（`Page.getAppManifest`，CSP 拦住即红）、引擎按声明尺寸解码图标、maskable 安全区、`black-translucent` 的单一 top-inset owner |
| 真机 | `docs/manual-mobile-verification.md` **F 段**（安装 / standalone / 状态栏与 safe-area / 登录过期 / 抽屉与软键盘）。**自动通过只允许 P1 候选送审**；`#471` 关闭仍须双平台真机验收 |

## 5. 已知边界

- **无 Service Worker**：Chromium 自 108（Android）/ 112（桌面）起从菜单安装不再要求带 `fetch` 的 SW。**订正（已撤回原归因）**：不得把「没有自动安装横幅」归因于「无 SW」——当前官方安装条件（[web.dev · install criteria](https://web.dev/articles/install-criteria)）**未**将 SW 列为 `beforeinstallprompt` 的必要项；真机若未出现横幅，按实际观察记录并登记为**未定性**（P2 观察范围）。
- 离线、更新提示、缓存策略一律**未实现**，也**未验证**。
- 真机（iOS / Android）、非 Chromium 引擎、非零 safe-area 的**真机读数**均未取得 —— 见 `P471/HANDOFF.md` 的「未证实项」。
- **`/app`（无尾斜杠）不在 `scope: "/app/"` 内**：浏览器解析出的 scope 已实测为 `…/app/`，`start_url` / `id` / `/app/note/*` 都在其中，`/app` 不在。仓库仍有会导航到 `/app` 的路径（`frontend/app/features/vault/controller.js` 的 `location.replace("/app")`、登录 `next` 默认值 `/app`、会话过期后 303 的目标）。在 standalone 里这类跳转**是否**被引擎当作跨 scope（改用浏览器 UI）**未实测**；本刀不改 `features/**`，故列为**待裁定项**：方案 A = 后续切片把内部导航统一为 `/app/`；方案 B = 把 scope 放宽为 `/app`（与 R5「三者统一 `/app/`」冲突，需席位裁定）。
