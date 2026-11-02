# dsh-archived-session-delete

在 DeepSeek Harness Web GUI 的侧栏里，**已归档会话**行尾的 `...` 菜单会多出一项 **删除会话**；
点击后弹出二次确认对话框，确认后由 Host 永久删除该会话的本地记录（JSONL 会话日志、
子代理会话、Workspace 记账、归档/置顶集合），并让所有已打开的页面立刻刷新列表。

> 本插件只允许删除**已归档**的会话。运行中或未归档的会话不会显示删除入口；Host 端同样会拒绝。

## 功能

- 侧栏 `...` 菜单 → **删除会话**（仅已归档行可见；位于内置“复制 Session ID”之后，带分隔线）。
- 二次确认对话框：显示会话标题、不可恢复警告、取消/删除按钮；删除进行中与失败信息都显示在对话框内。
- 删除同时清理：
  - 会话的 JSONL 持久化目录（`$DSH_HOME/sessions/<project>/<session-id>/`）；
  - 该会话隐藏的子代理（`origin: 'subagent'`）会话日志（递归；**不会**删除从它 fork 出来的会话）；
  - Workspace 会话记账（`detachSession`）、全局归档集合与置顶集合；
  - 若该归档会话在 Host 进程里仍有一个空闲 Agent（DSH 会为打开过的会话保留活实例），
    把它从活跃会话表中分离（`SessionStore.detachEntered`），避免列表继续出现一条日志已删除的“幽灵”行；
  - 通过 `api-session/removed` 通知浏览器刷新会话列表。
- 只读 `plan` 接口：先解析“将会删除哪些文件/会话”，不落盘，便于排查和测试。

## 安装

插件是一个普通的 DSH bundle 包（`dsh.bundle.patch` + `dsh.client`）。二选一：

### A. 通过插件管理器（推荐，运行中即时生效）

```sh
dsh plugin --profile web add link:/home/jiang/agent-talk/dsh-archived-session-delete
```

或在 Web GUI 的 **插件** 页面安装本地目录。profile 启用 HMR 时，安装后 bundle 补丁立即应用，
浏览器端由 client-plugin HMR 自动加载，无需重启。

### B. 手工写进 profile patch

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: archived-session-delete
      name: 'dsh-archived-session-delete'
```

并把包放进 profile 的 `node_modules`（`pnpm add link:...` 或复制目录）。重启 `dsh web` 后生效。

## 配置

Host 半侧接受一个可选配置项：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `sessionsRoot` | `$DSH_HOME/sessions` | JSONL 会话持久化根目录。仅当部署修改了 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `root` 时才需要显式设置。 |

例如在 profile patch 里：

```yaml
- id: archived-session-delete
  name: 'dsh-archived-session-delete'
  config:
    sessionsRoot: /data/dsh-sessions
```

## 工作方式

- **Host 半侧**（`lib/index.js`）注入 `connection` / `sessionPersistence` / `workspaceRegistry` / `sessions`，
  在 Connection RPC 上注册单段通道 `/archived-session-delete`：
  - `plan({ sessionId })`：校验会话已归档、未在运行，读出持久化 header 并解析出会话目录（含子代理后代）。
  - `delete({ sessionId })`：先做同样的校验，再 `rm -rf` 会话目录；随后尽力清理 Workspace 记账与归档/置顶集合；
    最后转发 `api-session/removed`。该通道走 Connection 的浏览器认证与 Host/Origin 信任栅栏，未认证请求到不了处理器。
- **浏览器半侧**（`lib/client.js`，手写 ModuleLoader bundle，无构建步骤）只使用外壳静态模块表里的
  `react`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`，注册两个 slot：
  `sidebar.workspaces.session.menu.item`（菜单项）与 `shell.overlay`（确认对话框）。

## 安全与限制

- 删除是不可撤销的。插件没有“回收站”：确认即从磁盘删除该会话的本地记录。
- 只删除**本地**记录；已经上传到模型的会话日志、外部备份不在清理范围内。
- 已归档会话的子代理日志会一并删除；从它 fork 出来的会话会被保留（fork 血缘不等于子代理归属）。
- **运行中**的会话（Agent 状态为 running，或仍有 turn / 子代理 / 后台任务 / 定时提醒在跑）会被拒绝，
  返回 `session-active`；已归档会话通常处于空闲，可以直接删除。
- 归档会话可能仍有**空闲**的活 Agent（DSH 对打开过的会话保留实例）。删除会一并把它从活跃会话表分离，
  但该 Agent 对象本身要等 Host 重启才回收；这不影响删除结果，也不会让会话重新出现在列表里。
- 若同一会话正被其他进程以写者身份打开（例如另一个 dsh 进程），删除可能失败；请先停止该进程。
- 会话投影缓存（`$DSH_HOME/storages/session_projcache/`）中可能残留该 id 的检查点文件；
  它不会让已删除会话重新出现在列表中（生命周期身份不匹配即被忽略），后续可安全手工清理。
- 插件依赖当前 DSH（0.2.1-rc.5）的公开 slot 与 Connection 服务；升级 DSH 后如 slot 或服务改名需要同步调整。

## 验证记录（2026-11-02，本机运行中的 Web GUI）

本工作区已按 **A 方式**把插件装入 `web` profile 并在线激活（`pluginManager/listBundles` 显示
`enabled:true, installed:true, source:link:...`；`listPlugins` 显示 Host 行 `fiberPhase:"active"`）。
验证分三层：

1. **离线单测**：`node --test tests/*.test.mjs` —— 14 项通过（路径编码、删除计划、Workspace 记账清理、
   HTTP 路由鉴权/信封、浏览器 bundle 的菜单项与确认对话框流程）。
2. **Host 端到端（一次性测试会话）**：通过 Remote RPC 创建一个临时会话 → 真实对话 → 归档 →
   `plan` → `delete` → 校验会话目录已删除、`session/list` 不再包含、归档/置顶集合与 Workspace 记账已清理。
   `E2E PASS`（脚本：`../tools/lead/e2e-delete.mjs`）。
3. **浏览器 UI 端到端（真实点击）**：headless Chromium 登录 GUI → 仅显示已归档 → 在一次性会话行
   `...` 菜单点击 **删除会话** → 确认框 → 点击 **删除** → 行消失、无报错、侧栏仍可用；
   其余归档会话不受影响。`PASS 33/33`（脚本与截图：`../tools/e2e/`；截图见
   `../tools/e2e/artifacts/delete-confirm.png`、`delete-after.png`）。

已知遗留：派生投影缓存文件 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 不会被本插件清理
（它是不可见的派生数据，生命周期身份不匹配时不会被读取；不影响列表与计数）。

## 开发

```sh
node --test tests/*.test.mjs     # Host 纯逻辑 + 浏览器 bundle 的离线冒烟测试
node --check lib/index.js && node --check lib/client.js
```

- `tests/paths.test.mjs`：目录编码、删除计划（归档校验/子代理后代/live 拒绝）、Workspace 记账清理。
- `tests/client.test.mjs`：以假 `require`/假 Context 执行浏览器 bundle，驱动菜单项与确认对话框，
  断言 RPC 调用、列表刷新与取消行为。

目录编码（`encodeSegment`/`projectKey`）与官方 JSONL 后端保持一致，用于从会话 id + header cwd
反推磁盘路径；修改时请对照 `@deepseek-ai/dsh-session-persistence-jsonl` 的实现。
