# dsh-memory-gate 设计说明

> 一句话：**把 `dsh-custom-headers` 的「按模型选配置」骨架，改造成「按模型/按会话决定这次请求要不要带记忆身份头」。**

## 0. 来历（为什么是「改造」而不是新写）

本插件从 [`EPCN-fla/dsh-custom-headers`](https://github.com/EPCN-fla/dsh-custom-headers) v0.4.4 派生：

| 原插件 | 本插件 |
| --- | --- |
| 命名请求头配置（`HeaderProfile`：name/value 列表） | 命名记忆身份（`IdentityProfile`：team/agent/task + 额外头） |
| 模型行下拉框选「头配置」 | 模型行下拉框选「记忆身份 / 摘链 / 默认」 |
| 在 pi-ai 适配器 `stream()` 上给模型描述符打 `headers` | 在 DSH 内核 `llm-pi-ai/request-headers` waterfall 上直接盖章 |
| 设置卡片编辑配置 + 校验 | 同左，另加默认身份、头名、预算、会话头开关 |
| 无状态 | 每会话一次决策并**钉住**（见 §3） |

保留的东西：DSH 插件包形状（`cordis.patch.yml`、host/client 双半端、`package.json#dsh`）、schemastery 校验、设置卡片写入路径、模型行 DOM 注入、vitest 测试结构、构建脚本。

## 1. 它解决的问题（来自 `session-3a596d7e…` 与 `06-记忆链与模型通路.md`）

1. DSH 的 `magpie` provider 的 `baseURL` 是 `http://127.0.0.1:8096/dsh/default` —— 那是 **TDAI 记忆代理**，不是 Magpie。
2. 代理只有在请求带 `x-team-id` / `x-agent-id` / `x-task-id` 时才做身份预选；**不带头 ⇒ 落 `bypassed=true`，且是终态**：之后每轮 `skipping all injection`，连 L0 都不写。⇒ 会话第一笔请求就决定了这个会话「有没有记忆」。
3. 反过来，判定层（Router/Watchdog）**不该**被记忆注入 —— 会话 `06` §4.1 给了三条「记忆改变判定」的机制。原设计的解法是让它们走 `stepfun`/`tokenrhythm` 直连，但那两把 key 当前不存在；**在客户端按模型摘链**是零依赖的等价手段。
4. 代理不认 `x-deepseek-harness-session-id`？不，它认（`resolveConversationId`），但 **DSH 不发**。补上这一个头，代理就能把一个 DSH 会话当成一个会话，而不是每轮一个新会话。

## 2. 两个 waterfall（实测自 DSH 0.2.2-rc.1 内核）

| 事件 | 何时 | 拿到什么 | 我们做什么 |
| --- | --- | --- | --- |
| `llm/stream` | 每次模型请求，适配器派发前 | `provider/model/sessionId/messages` | 只观察：粗估 token，记到当前会话 |
| `llm-pi-ai/request-headers` | pi-ai 适配器每次推理、真正发 HTTP 头之前 | `provider/model/baseURL/sessionId` + 可变 `Headers` + `next` | 决策并 `headers.set(...)` |

- 两者都是 `ctx.waterfall`，监听器**同步**执行，`next()` 之后才是内核自己的行为。失败必须 fail-open（加不上头 ≠ 发不出请求）。
- 只有 pi-ai 适配器有 `request-headers` 这道缝；`dsh-llm-deepseek` 直连路由不经过它 → 本插件对那条路由无副作用（这是正确的：那条路由本来就没有记忆）。

## 3. 决策（`src/gate.ts`）

```
not a memory-chain baseURL           → skip（一个头都不加）
会话已有钉住的决策                    → 用钉住的（即使配置改了）
模型 pick = off                      → detach（不加身份头）
首请求预估 token > 预算               → detach 且钉住（reason=budget-exceeded）
默认身份不存在 / 模型指定身份不存在    → detach
否则                                 → attach（身份三件套 + 额外头 + 会话头）
```

**为什么要钉**：见 §1 的 `bypassed` 终态。会话中途改主意 = 该会话永久失去记忆。所以「第一次决策」写入 `~/.dsh/storage/memory-gate/sessions.json`，此后同 `sessionId` 一律复用，配置变更只影响**新会话**。

## 4. 落盘

| 文件 | 内容 | 策略 |
| --- | --- | --- |
| `sessions.json` | `sessionId → {identity \| null, reason, at, provider, model}` | 载入同步、写入防抖 1s、上限 2000 条（按 `at` 丢弃最旧） |
| `decisions.jsonl` | 每笔记忆链请求一行 JSON（ts/kind/reason/provider/model/session/identity/tokens/chain） | 追加写；>2MB 轮转为 `.1` |

`~` 取 `$DSH_HOME`，否则 `$USERPROFILE`/`$HOME` + `/.dsh`。

## 5. 边界（明确不做）

- **不读也不写记忆仓内容**。L0/L1/L2/L3 的读写仍由 8096 代理负责；本插件只决定「这一笔请求是否让代理认领它」。
- **不改服务端预算**。`tdai.memory.l1Limit/l2Limit`、`injection.injectors` 在服务器 YAML 里，客户端无法按请求覆盖（已读 `MemoryProxy/src/config.ts` 确认）。本插件的「预算」是**客户端闸门**：估算请求体量，超阈值就在会话首笔请求时摘链，避免「记忆 + 超长上下文」叠加。
- **不新增隧道转发**。8420/8125 目前没有出现在 `forwards.conf` 里；本插件不需要它们。
- **不碰平面 B（new-api 公益站）**。

## 6. 验收

1. `npm run typecheck && npm test && npm run build && npm run pack:check` 全绿。
2. 装进 `desktop` profile 后，设置页出现「记忆闸门」卡片；模型页每行出现记忆身份下拉框。
3. 真实请求下：`decisions.jsonl` 出现 `attach identity=…`，且 `sessions.json` 出现该会话的钉住记录；把某模型设为「摘链」后，新会话出现 `detach reason=model-detached`，而**旧会话仍是 attach**（钉住生效）。

## 7. 装进真实 profile 才暴露的五件事

### 7.1 一次误判：`.volatile()` 探测的坑不在 `volatile`，在 `resolve` 的参数顺序

先把结论说清楚：**`live()` 从第一版就是对的**，不需要改成"内联链式调用"。`volatile()` 给自己的 schema 打上 `meta.volatile` 并返回同一个 schema，所以在已构建的字段上调用它完全正确。18:06 装进 profile 的那一版（就是原始 `live()`）确实在真实内核里挂载成功并持续写决策日志，这就是最直接的证据。

我当时判它"坏"是因为自己写错了一行探测：

```ts
Schema.resolve(markedSchema, 'x')   // ❌ 参数传反了
Schema.resolve('x', markedSchema, {})  // ✅ 值在前、schema 在后
```

`Schema.resolve(data, schema, options)` 的签名是**值在前**。传反后它把 schema 当成值、把值当成 schema，对任何健康的 schema 都会抛 `unsupported type "undefined"`——我因此误以为 schema 构建错了，并"修"了一个并不存在的缺陷。原始代码回退后，用正确的参数顺序调用 `resolve` 立刻通过。

教训比结论值钱：

- 探测代码本身也是代码，它的 bug 会伪装成被测对象的 bug。判断"某功能坏了"之前，先证明探测是对的。
- 三条互相独立的证据指向同一结论时（旧构建在真实内核里正常工作、实测原始 `live()` resolve 通过、错误只在参数顺序颠倒时复现），应当推翻假设，而不是继续修补。

`supportsVolatile` 仍然保留，但它的职责是**版本门禁**（3.18.2 之前没有 `.volatile()`），且现在会真正用一次正确签名的 `resolve` 验证探测结果，避免把"有 volatile 但没有 meta 语义"的版本放行。

### 7.2 单测绿不代表内核能加载

`apply()` 是内核**在校验之后**才调用的，所以直接 `apply(config)` 的测试永远碰不到 schema 层：一个能构建但 resolve 不了的 `Config` 会带着全绿测试装进 profile，然后在内核里炸。`tests/host.spec.ts` 的「Config schema under the real schemastery」那组因此用真实 `Schema.resolve` 覆盖空配置 / 完整身份 / 部分配置三种输入。

这组测试在 7.1 里起到了作用：它按正确签名调用 `resolve`，证明 schema 一直是好的，也是我最终发现误判的依据之一。

### 7.3 安装方式：用 tarball，不要用 `link:`

`link:` 会让插件按自己的 `node_modules` 解析依赖，于是它拿到 schemastery 3.19.0，而同 profile 的其它插件都拿 3.18.5——多出一份实例。`Symbol.for('schemastery')` 虽然让两边互认，但任何版本行为差异都会变成只有这一个插件踩到的坑。`file:` tarball 交给 pnpm 托管，解析路径与其它插件完全一致（已实测解析到 profile 根 3.18.5，且插件目录内没有嵌套 `node_modules`）。

### 7.4 陈旧的 tarball 会伪装成一次成功安装（真实缺陷）

`install-profile.mjs` 最初写成"tarball 存在就跳过 build + pack"。回退 §7.1 的改动后我重跑了 `npm run build`，却没有重新打包，于是：

- 脚本报告的每一步都成功；
- 装进去的 `lib/index.js` 与**当时**的 `artifacts/*.tgz` 完全一致；
- 但那个 tarball 是上一轮的产物，比 `src/` 落后十几分钟。

字节比对是"构建 vs 安装"，两边都指向旧内容，所以它照样通过。真正落后的那一环（`src` → tarball）没人检查。修法是**每次都无条件重新 build + 重新 pack**，并在 pack 前先删掉旧 tarball，避免打包失败时旧文件被下一次运行捡走。

同一类问题的第二层在 pnpm 侧：lockfile 的 `file:` 依赖记录着 tarball 的 `integrity`。只替换 `.tgz` 而不动 specifier，pnpm 会说 `Already up to date` 并复用上次的解包目录——即使目录已被删掉，它也能从 store 里恢复旧内容。所以脚本还会删掉该包在 lockfile 里的 importer 与 packages 两条记录，逼它重新计算哈希。

`scripts/install-profile.test.mjs` 用静态断言锁住这两点（含"找不到可删记录就硬失败"，避免静默变成空操作）。

### 7.5 决策日志的追加顺序（真实缺陷）

`appendDecisionLog` 原本每行各跑一次 `stat` + `appendFile`，两行并发时后发的可能先落盘，日志里就会出现 `pinned` 排在造成它的 `attached` 之上。现在按文件串成一条链（`logTails`），追加顺序等于调用顺序，`flushDecisionLog(dir)` 可以等最后一行落地。测试 `store.spec.ts` 的「orders a batch of appends by call order」锁住这条契约。

顺带两个边界：目录在排队期间被删除（卸载、临时目录清理）时该行**静默丢弃**而不是告警——日志是诊断素材，不是状态；`mkdir` 必须在入队时同步完成，放到队列里执行会在这个窗口里造出目录或撞 ENOENT。

### 7.6 会话头为什么必须是 `x-deepseek-harness-session-id`（一次差点改错）

装配完之后我一度判断这里有个缺陷：设计文档里的示例请求头写的是 `x-session-id`，而插件发的是 `x-deepseek-harness-session-id`，于是打算"改正"过来。这个判断是错的，原因值得记下来。

代理的 `session/session-key.ts` → `resolveConversationId()` 是按顺序读**七个**候选头，取第一个非空值：

```
1 x-parent-conversation-id   2 x-conversation-id   3 x-session-id
4 x-claude-code-session-id   5 x-deepseek-harness-session-id
6 x-chat-id                  7 x-thread-id
```

- 设计文档的示例用 `x-session-id`，只是因为**七个里任意一个都能生效**，它排在第 3 位而已；示例不是规格。
- 代理源码在**第 5 个**候选上注释 "dsh (deepseek-harness) sends this"，而实测 DSH 从不发它——这正是代理日志里 `conversationId=null` 出现 975 次的原因。插件补第 5 位才是对症的修法；还能避开第 3 位，将来真有别的组件设 `x-session-id` 也不会互相抢优先级。

更关键的是：**注入量无法用来区分这两个头**。实测带身份头时 `prompt_tokens` 恒为 3541~3543，不管发哪个会话头都一样——因为代理注入的是 L2/L3 画像，不重放对话历史。所以"同一 id 连发两次看 prompt 是否增长"这个看起来很合理的实验，根本测不出来。判定只能靠解析链本身。

教训：**示例值不是规格**。用户可见的文档示例常常只是众多可行取值之一，动代码前要去读实现里真正的判定逻辑。