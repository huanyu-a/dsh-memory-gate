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

## 7. 两个已踩过的坑（装进真实 profile 才暴露）

### 7.1 `.volatile()` 只能内联链式调用

DSH 桌面 profile 实际解析到的是 `@deepseek-ai/schemastery@3.18.5`（profile 根），而不是我开发目录里的 3.19.0。`volatile()` 的语义是**给它被调用的那个 schema 打标记并返回同一个 schema**，不是返回包装器：

```ts
const ok = Schema.string().default('x').volatile()   // ✅ meta.volatile = true
```

先建好字段再把 `.volatile()` 的结果包一层，会得到一个 `type === undefined` 的坏 schema，`Schema.resolve` 直接抛 `unsupported type "undefined"`。改正方式是让 `live()` 接收一个**构造函数**、在内部内联打标：

```ts
function live<T>(build: () => Schema<T>): Schema<T> {
  const field = build()
  if (!supportsVolatile) return field
  return (field as unknown as { volatile(): Schema<T> }).volatile()
}
```

顺带记一个签名坑：`Schema.resolve(data, schema, options)` **值在前、schema 在后**。传反了同样报 `unsupported type "undefined"`，会让人误判成 schema 坏了。探测结果要经过一次真实 `resolve` 才可信，否则 3.18.2 之前那种"有 volatile 但没有 meta 语义"的版本会被放过。

### 7.2 单测绿不代表内核能加载

`apply()` 是内核**在校验之后**才调用的，所以直接 `apply(badConfig)` 的测试永远碰不到 schema 层。`tests/host.spec.ts` 里「Config schema under the real schemastery」那组用真实 `Schema.resolve` 覆盖空配置 / 完整身份 / 部分配置三种输入，就是为了补这个盲区——上面 7.1 的缺陷正是它之前漏掉的。

### 7.3 安装方式：用 tarball，不要用 `link:`

`link:` 会让插件按自己的 `node_modules` 解析依赖，于是它拿到 schemastery 3.19.0，而同 profile 的其它插件都拿 3.18.5——多出一份实例，`Symbol.for('schemastery')` 虽然还能互认，但任何版本行为差异都会变成只有这一个插件踩到的坑。`file:` tarball 交给 pnpm 托管，解析路径与其它插件完全一致（已实测解析到 profile 根 3.18.5，且插件目录内没有嵌套 `node_modules`）。