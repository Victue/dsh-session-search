# dsh-session-search

[English](README.md) | **中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**全部会话的具体内容**里做全局搜索（不只是会话标题），结果**按命中记录自身的时间倒序**排列。

它在侧边栏加了一个一等公民的搜索入口（*Plugins* 与 *Schedules* 之间的面板图标 + 一个全宽结果页），并注册了 `Ctrl/Cmd+Shift+F` 快捷键。点任意一条命中即可打开对应会话。

```
┌─ 侧边栏 ──┐  ┌─ 主区域 ───────────────────────────────────────────────────┐
│  Plugins  │  │  搜索会话内容                                               │
│ ▸ 搜索    │  │  [ 会话                                             ]       │
│  Schedules│  │  全部 · 我的提问 · 助手回复 · 工具输出      ☐ 包含子代理    │
│           │  │  43 条命中 · 8 个会话 · 4 ms                                │
│           │  │ ──────────────────────────────────────────────────────────  │
│           │  │ 2026-09-11 01:55   user   修改 FreeCAD MCP 服务端口          │
│           │  │   我在使用这个 mcp 服务[插件]，但是端口被占用了…             │
└───────────┘  └────────────────────────────────────────────────────────────┘
```

---

## 为什么需要这个插件

原生 DSH 其实**已经**接着一套内容检索管线 —— 侧边栏那个搜索框调的是真东西：

```
WorkspaceBrowser → sessions.search(query) → ctx.remote.session.search
  → SessionController.search → ctx.sessionQuery.searchSessions(…)
```

它之所以只能搜到会话名，是因为**三件事同时成立**：

| # | 事实 | 出处 |
|---|---|---|
| 1 | 内容检索后端在原生 profile 里被**显式关闭**：`openAt: never`。官方注释写得很直白：*"the Web sidebar search matches titles and workspace names only."* | `dsh-base/cordis.patch.yml` 的 `session-query-sqlite` 行 |
| 2 | 该后端用 FTS5 `unicode61` 分词，**一整段中文会被当成一个 token**。实测：`光速太慢，星际文明无法成为整体` 只切出 `光速太慢` 与 `星际文明无法成为整体` 两个词，于是 `MATCH '光速'`、`MATCH '星际'` **都返回空**。换成 `trigram` 分词器也没用 —— 它不接受 2 字查询。 | 本机对 SQLite 3.53.4 实测 |
| 3 | 就算把后端打开，跨进程返回的结构体是 `{ items: [{ sessionId, snippet }] }` —— **每条命中的 `time` 在这一层被丢掉**，而且排序是相关度优先（`time` 只是并列时的次序）。 | `dsh-api-session-controller/lib/index.js` |

也就是说，「按内容时间排序」**没法通过任何公开远程调用实现**；而对中文内容而言，官方那套引擎本身就是错的工具。所以本插件在主机端自建索引：增量解析全部会话日志，把每条记录的文本连同**该记录自己的 `time`** 一起保存，按**子串**匹配（中英文都正确），再按时间排序。**不需要改任何 profile 配置。**

---

## 搜索入口放在哪里，以及为什么不放别处

DSH 的 Web/桌面 UI **没有**全局顶栏，也**没有**全局命令面板（`/` 命令是输入框里的斜杠菜单，且绑定当前会话）。真正可用的全局位置只有三个：

| 位置 | 结论 |
|---|---|
| **`sidebar.panellist` 图标 + 配套的 `main` 面板** | ✅ **本插件采用。** 这是 DSH 一等公民的「全局面板」机制：侧边栏负责按钮、标签和选中态，list 的 `id` 直接对应 `main` 面板的 `key`。原生 **Plugins**（order 0）与 **Schedules**（order 10）就是这么做的，本插件插在中间（order 5）。`replaceRisk: none` —— 升级不会把它覆盖掉。 |
| `sidebar.footer.action`（设置按钮旁）+ `shell.overlay` 弹层 | ⭕ 可行的次选，更适合做成「聚光灯」式快速搜索。代价是要自己处理弹层、焦点与 Esc，而且结果区放不下多少片段。 |
| `sidebar.workspaces`（现有那个搜索框所在区域） | ❌ **不采用。** 它是 `single` 槽位，整体被 `ui-workspace` 占用，`replaceRisk: shadows-shipped-ui` —— 占它等于替换掉官方整个会话浏览区，DSH 一升级就可能碎。 |

另外通过 `dsh-client-shortcuts` 注册了 **`Ctrl/Cmd+Shift+F`**，可从任意位置切到该面板。该键**只在桌面端绑定**：Web 平台的 `KeyF + primary+shift` 已被官方 `session.fork`（`dsh-client-ui-workspace`）占用，而快捷键注册表会按**所有已声明平台**校验默认键，撞车时**后注册者**抛 `Conflicting shortcut defaults`。这个坑踩过一次，见[兼容性](#兼容性)。

**单会话内搜索**的入口则是 `conversation.session.header.utilities` —— 会话头部右侧那排操作按钮。它是增量槽位（`replaceRisk: none`，官方 `open-in-app` / `schedule-catalog` / `session-log-download` 已经并列在这里），始终在手边、不需要新增全局界面。查找条与结果弹窗共用同一个 `shell.overlay` 条目 —— 官方文档称之为「a frame-wide surface of your own」的那层 —— 浮在所有列之上，不占用任何一列。

---

## 安装

本插件是标准的 DSH **bundle**（`package.json` 里有 `dsh.bundle.patch` 与 `dsh.client`）。用插件管理器安装：

```
plugin_manager action=install_bundle target="<本仓库的绝对路径>"
```

它会把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，并在 profile 的 `node_modules` 里建链。**不需要**手改 profile 的 `package.json` 或 `cordis.patch.yml`。

停用 / 卸载：

```
plugin_manager action=set_bundle    target=dsh-session-search enabled=false
plugin_manager action=remove_bundle target=dsh-session-search
```

### 也可以手动挂载

在 profile 自己的 `cordis.patch.yml` 里加一行（`name` 可以是包名、相对于该 patch 文件的路径，或绝对路径）：

```yaml
- insert:
    - id: session-search
      name: 'dsh-session-search'
```

> **关于重新加载的行为。** Harness 用 Node 的 ESM 加载器加载插件行，**解析结果与模块本身都会在 Host 进程生命周期内被缓存**。重新启用一个曾经报错的行，跑的还是**被缓存的那个模块** —— 磁盘上的修复必须重启应用才能生效；`dsh-hmr` 能让**新**行生效，但换不了已加载包的 JavaScript 生成代。`lib/entry.js` 就是为此存在的：它按 mtime 加查询串动态载入 `lib/host.js`，让主机端改动在下次启用时就生效。正常使用下它就是入口文件。

---

## 使用

### 全局搜索

1. 点侧边栏的放大镜图标（在 *Plugins* 与 *Schedules* 之间），或按 `Ctrl/Cmd+Shift+F`。
2. 输入关键词。匹配是**子串**匹配、大小写不敏感，且对中文有效（2 字查询能命中更长的连续文本，这正是官方 FTS5 做不到的）。
3. 用筛选按钮收窄范围 —— *全部* / *我的提问* / *助手回复* / *工具输出*，以及 *包含子代理会话* 开关（默认关闭；子代理会话的数量常常远超你自己的）。页面顶部的**会话范围选择器只列出当前关键词真正命中的会话**，并带命中数（`标题 (12)`），点一下即可限定到该会话；没有输入关键词时才列出最近的会话。
4. 点任意一条命中即可**连同上下文一起查看**：该条记录本身 + 前后各 4 条，命中处高亮且不截断。用「上一处 / 下一处」在命中之间移动，用「在会话中打开」跳到会话本体。

### 会话内查找（Ctrl/Cmd+F）

按 `Ctrl/Cmd+F`，或点会话窗口右上角工具栏里的放大镜。会浮出一个查找条，直接在会话流里搜索：**所有命中都会高亮**，当前那一条自动滚到视野中央。

- `Enter` / `Shift+Enter`，或 `‹ ›` 按钮在命中之间跳转；`Esc` 关闭并清除高亮。
- 计数显示当前位置（`3 / 17`）。
- **在全部历史中搜索** 会把当前关键词交给索引弹窗 —— 那里还能搜到聊天区尚未渲染的历史记录。

实现方式：从会话流的**已渲染文本节点**里收集匹配区间，用 **CSS Custom Highlight API**（`::highlight(...)`）绘制高亮，因此**完全不改动**会话流的 DOM，React 也不会看到异常变更。这与浏览器自带 Ctrl+F 的边界完全一致 —— 聊天区是虚拟列表，只渲染一个窗口内的回合，窗口外的内容请用「在全部历史中搜索」。

> **为什么是 DOM 方案。** DSH 没有公开的会话导航 API（`ChatNavigation.navigateToTurn`、`scrollToTurn`、`loadThrough` 都只在聊天面板内部；槽位占用者只能拿到 `useChat` 这类只读快照选择器）。读取已渲染文本是唯一剩下的路径，而且本插件不向别人的 DOM 写入任何东西。将来 DSH 若改了会话容器标记，查找条会退化为「无匹配」而不会崩坏。

索引侧输入有 220 ms 防抖，被取代的查询会被 `AbortController` 取消。

---

## 配置

插件**刻意不导出 `Config` schema**：像 `@deepseek-ai/schemastery` 这样的裸模块名，从位于 profile 树之外的插件里解析不到；而 Cordis 在插件没有 `Config` 时会把行里的 `config:` 原样传入（`cordis/lib/index.js` 里的 `if (!runtime.Config) return config`）。因此所有键都是可选的：

```yaml
- id: session-search
  name: 'dsh-session-search'
  config:
    root: 'C:/Users/me/.dsh/sessions'   # 会话根目录，默认 <DSH_HOME>/sessions
    maxHits: 300                        # 单次返回上限
    maxCharsPerRecord: 65536            # 单条记录文本上限，防止某条巨型工具输出撑爆内存
    includeSubagents: false             # 默认排除子代理会话
    warmup: true                        # 启动后在后台建索引
    warmupDelayMs: 3000
```

注意 patch 行会**整体替换**目标 id 的 `config`，所以要写全你想要的值。

---

## 实现

```
package.json                bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml            bundle 补丁：insert 一行
icon.svg                    Plugins 页图标
locale/{en,zh}.json         Plugins 页标题与描述
lib/entry.js                加载器入口：导出 name/inject，并载入实现
lib/host.js                 主机端：索引生命周期、HTTP 通道、sessionContentSearch 服务
lib/core/session-index.js   纯 Node 索引与查询引擎（不依赖 DSH）
lib/client.js               浏览器端模块包：面板图标 + 搜索页 + 快捷键
test/host.test.mjs          主机端集成测试
test/client.test.mjs        浏览器端测试
```

### 会话日志格式

每个 `session.v<N>.jsonl.zstd` 是**一串互相独立的 Zstandard 帧**，不是单个流。Node 的 `createZstdDecompress` / `zstdDecompressSync` **只解第一帧**，所以朴素读法只会静默地拿到头部那一行记录。本插件扫描 zstd 魔数逐帧解压，并记录续扫偏移量以支持增量：文件增长时只解新帧，文件变小（压缩重写）时整段重来。

每帧解出来是若干 JSONL 行：

```json
{"type":"session","version":4,"id":"…","createdAt":1792130873584,"cwd":"D:\\Code\\demo","origin":"subagent"}
{"type":"user/message","seq":9,"time":1792130873619,"data":{"content":[{"type":"text","text":"…"}]}}
{"type":"assistant/message","seq":16,"time":1792130875479,"data":{"message":{"content":[{"type":"text","text":"…"},{"type":"tool-call","name":"read","arguments":"…"}]}}}
{"type":"tool/result","seq":17,"time":…,"data":{"message":{"content":[{"type":"tool-result","content":[{"type":"text","text":"…"}]}]}}}
{"type":"session/title","seq":14,"time":…,"data":{"title":"…"}}
```

只有 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`session/title` 会入索引。`system/message`（系统提示）与 `reasoning-chunks`（思维链）按设计排除 —— 否则它们几乎能命中任何查询。

真实 home 目录实测规模：**178 个会话 / 22k 条记录 / 21.4 MB 可搜文本**，冷建索引约 **1.2 s**，之后每次查询 **3–26 ms**（增量刷新 9 ms）。

### 主机 ↔ 浏览器

浏览器端调用 `ctx.connection.rpc.call('/session-search', 'search', {…}, signal)`。主机端在该路径上注册前缀路由，使用标准 Connection RPC 信封（`{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result:{ok,value}}`），并复用 Connection 服务的 `admit()` 准入栅栏 —— 未认证请求得到 401。

> ⚠️ **上游缺陷 —— 0.2.0-rc.2 复现，0.2.1-rc.2 依然存在。**
> `ctx.connection.rpc.handle()`（以及 `rpc.intercept()`）看起来是为此设计的 API，但插件用不了。
> 在 `dsh-client-connection/lib/index.js` 里，`get rpc()` 取 `owner = this.ctx`（`:724`）并传给
> `register(owner, …)`（`:855`），后者的最后一行是 `owner.effect(() => owner.webServer.register(route), …)`（`:871`）。
> 而该上下文只 inject 了 `credentials`（`:1013`），所以 `owner.webServer` 在它上面不是已注入服务，
> **每一次**注册都会抛 `cannot get property "webServer" without inject` —— 哪怕调用方插件自己的
> `inject` 里明明有 `webServer`。没有官方插件调用 `rpc.handle`，所以这个缺陷从外面看不见。
> 浏览器侧的 `rpc.call()` 是正常的，坏的只是主机端注册通道。`connection.fetch.register()` 不受影响
> （`registerFetchRoute` 不碰 `owner.webServer`），但它只是挂进 Connection 服务自己的 `/api` 分发，
> 并不会新建路由，所以不能替代。
>
> 复现方式：任意主机端插件在 `apply` 里调用 `ctx.connection.rpc.handle('/probe', async () => 1)`，
> 并且自己的 `inject` 带上 `webServer` —— 立刻抛错。本插件的绕过方式是：在自己的上下文（确实 inject 了
> `webServer`）上注册前缀路由，并复用 `ctx.connection.admit(request)` 拿到完全相同的信任/认证栅栏。

主机端另外 `ctx.provide('sessionContentSearch', …)` 暴露同一个索引，便于别的插件复用或人工排查 profile。

---

## 兼容性

在 **DeepSeek Harness 0.2.1-rc.2**（Electron 44.7.0、`@deepseek-ai/cordis` 4.0.5）上构建与验证。插件运行时**不依赖任何 Harness 包**，只依赖文档化的服务与槽位契约。

**0.2.1-rc.2 事故 —— 0.1.1 已修复。** 0.1.0 在 Web 平台也注册了 `Ctrl/Cmd+Shift+F`。而 0.2.1-rc.2 的 `dsh-client-ui-workspace` 内置了 `session.fork`，在 Web 上正好是 `KeyF + primary+shift`；`dsh-client-shortcuts` 会按所有已声明平台校验默认键，撞车时**后注册的一方**抛 `Conflicting shortcut defaults`。这次是 `ui-workspace`：它一挂，16 个等待 `uiWorkspace` 服务的客户端条目全部停在 pending，渲染进程启动直接变成致命错误 `web boot: 17 entries did not activate`；随后 DSH 的崩溃恢复把 profile 重置回了默认 bundle 列表。

0.1.1 起**只绑定桌面平台**，并且把注册过程包了 try/catch —— 将来官方再占用该组合，最多是这个面板失去快捷键，**不会**再影响应用启动。装过 0.1.0 的请更新后重新安装 bundle。

---

## 验证状态

- `npm test` → **27/27 通过**。
  - 主机端（16 项）：真实语料上的中文子串命中、时间倒序、子代理过滤、按会话限定范围、按会话的命中统计（facets）、会话选择列表、命中上下文窗口，以及完整的 *HTTP 路由 → RPC 信封 → 查询 → 负载* 往返，外加 405 / 404 / 400 / 信封不匹配等失败路径。
  - 浏览器端（11 项）：以页面加载它的方式（`window.__ModuleLoader__` + 工厂 + `require` 打桩）载入模块包，断言模块 id 等于包名、**只 require `react`**、四个入口全部注册（面板图标 / 主页面 / 会话头部按钮 / 弹窗层）、快捷键只声明桌面平台、**快捷键注册被拒时不会拖垮插件激活**，并渲染验证会话头部按钮、关闭态弹窗、命中列表与高亮、会话选择器（含"只列命中会话"行为）以及打开命中的弹窗。
- 安装结果：`application: "applied"`，`warnings: []`。
- 主机端：`POST /session-search/search` 返回 **401**（路由存在且被准入栅栏保护），而不存在的通道返回 405。
- 客户端：实时槽位检查显示 `session-search` 在 `sidebar.panellist`（order 5）与 `main`（同 key）中**均已注册且 active**。
- **整机重启确认：** 挂载本 bundle 后，DSH 0.2.1-rc.2 完整重启一次即正常启动，未产生任何 `crash-*.log`，面板图标注册成功、主机路由在线。

**未验证：** 作者构建此插件的环境没有浏览器控制能力，因此**没有做视觉验证** —— 即没有实际点击图标、输入关键词、看到渲染结果。按 `cordis-plugin-development/references/verification.md` 的要求，结论只到「语法 + 清单 + 实时槽位注册 + 组件可渲染」这一层。最终观感请你自己确认。

---

## 已知限制

- **查找条只能命中"已渲染"的内容。** 聊天区是虚拟列表，只把窗口内的回合放进 DOM，所以 `Ctrl/Cmd+F`（和浏览器自带查找一样）只能看到已渲染部分；其余内容用查找条里的「在全部历史中搜索」或索引弹窗覆盖。仍然无法做「深链到某个事件序号」——`ChatNavigation.navigateToTurn` / `input.loadThrough(seq)` 是聊天面板私有的。
- 快捷键**仅桌面端有效**；Web 平台留空，以免与官方 Web 绑定撞车（见[兼容性](#兼容性)）。侧边栏图标始终可用。
- 索引在内存里，随 Host 进程存活；不做磁盘持久化（冷建约 1.2 s，通常无感）。
- 匹配是**子串**匹配，不是分词，也不是语义检索。多个以空格分隔的关键词之间是 AND 关系。
- 单条记录文本超过 `maxCharsPerRecord`（默认 64 KiB）的部分会被截断。
- 官方 SQLite FTS 后端仍然关着，本插件刻意**不**去打开它：即使打开，它对中文子串也无能为力（见上文第 2 点）。如果你更想要「官方后端 + 相关度排序」，那是一次独立的配置改动，不是插件能做的事。

---

## 开发

纯 ESM，无构建步骤 —— `lib/*.js` 就是发布产物。需要 Node ≥ 22.15（依赖 `node:zlib` 的 Zstandard 支持）。

```bash
npm test          # node --test test/host.test.mjs test/client.test.mjs
```

主机端测试跑在 `<DSH_HOME>/sessions` 的真实会话上；该目录不存在时会自动跳过。

## 许可证

[MIT](LICENSE) © Victue
