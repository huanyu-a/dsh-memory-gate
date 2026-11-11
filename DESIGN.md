# DSH Memory Gate：维护设计

用户安装和配置见[中文 README](<README.md>) / [English README](<README.en.md>)。本文描述当前源码契约，不把源码注释中的部署历史或代理行为当成外部保证。

## 1. 事件与决策矩阵

[Host 入口](<src/index.ts>)依赖 `settings`，注册 `internal/config` 和同步 `llm-pi-ai/request-headers` waterfall。它不注册 `llm/stream`、不检查正文、不估算 tokens、不实现预算。请求监听器提取 `provider/model/baseURL/sessionId/purpose`，读取配置，调用[纯决策函数](<src/gate.ts>)，更新 pin、逐行 `Headers.set`、记录诊断，最后调用 `next()`。

空 provider/model 直接继续；请求上下文的非空 `baseURL` 优先，否则读取 provider 配置。空 session ID 视为不存在。只有 `purpose === undefined` 才允许新建 pin，空字符串也属于已定义 purpose。

按下列顺序判定，前项优先：

| 条件 | kind / reason | 新 pin |
| --- | --- | --- |
| URL 不匹配 | `skip / not-memory-chain` | 无 |
| 已有 pin，identity 为 null | `detach / pinned` | 无 |
| 已有 pin，身份无法解析 | `detach / pinned-identity-missing` | 无，保留原 pin |
| 已有 pin，身份存在 | `attach / pinned` | 无 |
| 模型选择 `off` | `detach / model-detached` | null，若允许 |
| 使用默认但默认身份为空或不存在 | `detach / no-default-identity` | null，若允许 |
| 模型指定身份不存在 | `detach / identity-missing` | null，若允许 |
| 身份存在 | `attach / attached` | 身份 ID，若允许 |

“若允许”指有 session ID 且请求可钉住。辅助请求不创建 pin，但复用已有 pin；没有 pin 时依然按当前模型选择发送头。因此辅助请求不钉住只是**本地策略**，不保证代理无注册、bypass、注入或写入副作用。

### 显式 origin 信任

[URL 识别](<src/identities.ts>)通过 URL 解析后按协议/主机/端口组成的 origin 精确匹配 `trustedOrigins`；默认仅 `http://127.0.0.1:8096`，空数组全部禁用。白名单只接受无凭据/查询/片段/非根路径的 HTTP(S) origin。请求 URL 可带代理路径，但拒绝凭据及非 HTTP(S)。关键词与端口子串不再作为授权依据；远程代理升级前需显式配置，旧 pin 不绕过此检查。

### pin 的真实契约

新 pin 记录 `identity`（ID 或 null）、`reason/at/provider/model`，并额外保存 `snapshot`：身份三值、额外头、头名和会话头开关的深拷贝。已完成快照的 pin **不再读取实时身份配置**，因此编辑或删除身份不会改变已钉住会话的头；新会话才按新配置决定。会话 ID 仍是唯一键，pin 不按 provider/model/profile 分区，非匹配 URL 在 pin 读取之前就被跳过。

旧 pin 没有 `snapshot`，只有 ID。首次被 `pinnable !== false` 的请求使用时，用**当时**配置补快照并写 `migratedAt`，此后冻结；该 pin 由加载器原样保留，迁移发生在 gate 决策而非读取。原始历史值从未写盘，无法还原；ID 缺失则保持摘链。辅助请求不迁移，也不写 pin 文件。迁移保留原始 `at`（首次决策时间），裁剪改用 `max(at, migratedAt)` 排序，因此刚迁移的旧会话不会在同一轮被淘汰，也不会把活跃新会话挤出。

**快照只在值本身合法时写入。** `snapshotOf` 复用 `assertValidSection` 的规则检查身份与头名，任一项不合法就只写旧式 ID-only pin；否则组合 base 里一个临时错误（空 team、非法额外头名、占用会话头名、头名重复）会被永久固化到某个会话，即使后来修好配置也无法纠正。加载器对快照做同样校验并整条拒绝，包括头名不得占用会话头、不得重复、不得为空；`migratedAt` 无有效快照时一并丢弃，避免“声称已冻结却仍跟踪实时配置”。

**摘链删除当时与当前的头名。** 新建的 pin（挂载与摘链都算）在头名合法时保存 `removeHeaderNames`（当时的三个头名），`removeHeaders` 取"当时 ∪ 当前 ∪ 会话头"的并集，因此重命名后旧名仍会被清除。旧版 pin 没有该字段，只能删当前头名；任意额外头始终不动，所以摘链仍不是完整清洗。

`trustedOrigins`（随配置实时读取，不写入快照）在 pin 复用**之前**检查，所以白名单收紧会立即让钉住会话失去身份头。pinning 的动机是适配可能将 bypass 视为终态的代理协议；删除本地 pin 不会发送代理重置操作。存储按 `max(at, migratedAt)` 裁剪、不支持跨进程协调（无锁、无合并），快照只保证“内容不随配置漂移”，不保证会话终身保留。

## 2. 配置与兼容性

[清单](<package.json>)定义包名 `dsh-memory-header-gate`、host/client 出口、Web client 与[组合补丁](<cordis.patch.yml>)。补丁行 ID / settings namespace 为 `memory-gate`；模型配置在 `llm-pi-ai` 的 provider/model 行 `memoryGate` 字段。

[配置解析](<src/identities.ts>)提供默认值、宽松 normalize 和写时校验。ID 比较去空白且大小写不敏感；模型 `off/default` 保留值同样大小写不敏感，其他字符串为身份 ID，空值/非字符串回退 default。保存时拒绝保留值作为身份 ID。

| 能力分支 | 实现方式 | 证据边界 |
| --- | --- | --- |
| 支持 volatile 的 schema | 探测 `.volatile()` 并调用 `Schema.resolve(value, schema, {})`；identities/defaultIdentity/sessionHeader 标记 live | 真实 schema 单测，不等于所有宿主版本集成通过 |
| 新设置服务 | `configure({auto:false})`；读取 describe 与 configEditor 用户层，用户层覆盖组合 base | 结构化能力探测与模拟服务测试 |
| 旧设置服务 | 无 configure 且有 installSection 时注册 namespace、校验和 source | 兼容分支测试，不是旧版桌面实测声明 |
| Cordis 配置校验 | `internal/config` 支持 owning fiber 绑定到 `this` 或首参两种形状 | 两种调用形状单测 |
| Web 卡片 | `plugins.bundle.config`；旧分支 `settings.plugin.item` | 源码与测试，不代表本次真实浏览器验收 |
| 模型 picker | MutationObserver + DOM 标签锚点 + React root | 依赖宿主 DOM、locale 和 remote 协议 |

头名一律按大小写不敏感处理（HTTP 语义），而 JS 的 `Record` 按精确键去重——这一差异曾导致四个缺陷：额外行覆盖身份头、额外行彼此重名丢值/发重复头、配置头名撞会话头（关闭开关时把常量值写成对话键，合并所有会话）、三个配置头名仅差大小写时发重复头。现在校验层给出 `name-conflict` / `name-duplicate` / `name-reserved` 并拦保存，装配层独立再兜底：身份字段最后写入、占用已配置名的行被丢弃、同名的配置头名只保留 team > agent > task 中的第一个、与会话头同名的配置名一律不写。因此**装配层保证「同一头名最多一个值」且「会话头下绝不出现常量身份值」**，即使组合 base 绕过了校验。`tests/composition-invariants.spec.ts` 用穷举组合看护这两条不变量。组合 base 在 `apply()` 入口会校验并 `console.warn`，但**不阻断加载**（仍 fail-open）；运行时逐行盖章仍可能失败。

[客户端](<src/client/index.ts>)管理中英文词典、卡片槽位、DOM 注入和销毁。模型选择通过[配置操作](<src/client/ops.ts>)写入，默认选择可移除字段；配置更新/重连会失效扫描缓存。折叠行或未保存 provider 的控件行为需要结合 UI 验证，不能以 host 单测代替。

兼容性需分三层报告：

1. 清单 peer 范围是依赖准入范围，不是逐版本验收清单。
2. 当前 `dshCompatibility` 精确声明 DSH `0.2.2-rc.1` / Cordis `4.1.0` / Schemastery `3.19.0`；[CI cohort 脚本](<scripts/ci-compatibility.mjs>)据此选择版本，不证明 CI 已实际运行成功。
3. 真实应用加载、Web 渲染、代理收头/注入必须另有实测证据；不在本文中补写“实测兼容”。

## 3. 存储与失败策略

[存储实现](<src/store.ts>)使用 `DSH_HOME`，否则 `USERPROFILE ?? HOME` 下 `.dsh`，再退化为相对 `.dsh`。数据在该根的 `storage/memory-gate`，不按 profile 隔离。

| 数据 | 行为 | 边界 |
| --- | --- | --- |
| `sessions.json` | 同步读；恢复可识别 pin（含完整 snapshot 与清理用的 `removeHeaderNames`，任一快照字段缺失/类型不符或不符合写时规则则整条丢弃）；JSON version 为 1；写临时文件后 rename | 不可读时先把原文件复制为 `sessions.json.corrupt-<时间戳>` 再按无旧 pin 处理；无跨进程锁；2,000 条满额实测约 1.26 MiB、加载约 53ms（用 `tests/store.perf.spec.ts` 可复现，数值随机器浮动） |
| pin flush | 首次 dirty touch 同步尝试写，后续 1 秒定时器防抖；dispose flush | 有同步 mkdir/序列化/写盘，不能宣称请求路径无磁盘 I/O；崩溃可能丢变更 |
| pin 上限 | flush 时按 `max(at, migratedAt)` 倒序保留 2,000 条 | 非 LRU；读取/使用不刷新 at；迁移不刷新 at 但参与排序，避免刚迁移即被淘汰；加载和 flush 之前内存可超限 |
| `decisions.jsonl` | 同一进程、同一文件按 promise tail 顺序异步追加 | mkdir 仍同步；无跨进程顺序保证；无有界写队列 |
| 日志轮转 | 追加前 size ≥ 2 MiB 时尝试 rename 至 `.1` | 不是严格磁盘上限；rename 失败继续追加，`.1` 行为受平台影响 |

日志字段固定为 `ts/kind/reason/provider/model/session/identity/chain`，**没有 tokens、正文或身份头值**；skip 不落日志。每个 session（无 session 时 provider/model）另有一次控制台摘要；该 announced Set 不做淘汰。

写 pin 前 dirty 已清除，写失败会告警但不自动恢复 dirty/保证重试；内存 pin 可继续生效，重启后可能丢失。日志 ENOENT 可静默丢行，其他失败告警；dispose 发起 best-effort drain，不把退出清理等同于可靠提交。

请求处理 catch 后继续 waterfall，单个非法头行独立丢弃。这里的 fail-open 是**尽量继续调用宿主 next**，不是“请求绝不失败”或“失败时撤销所有头”：此前已成功写入的头不会回滚，除 detach 的核心头清理外，已有头不会回滚，宿主/后续监听器/网络仍可能失败。attach 日志是决策记录，不是逐行盖章成功凭证。

多个进程共享根路径、各有内存 Map，**没有文件锁、没有合并、没有 CAS**：每个进程 flush 时整表重写，最后一次写入决定文件内容，可能丢掉其他进程的会话。日志轮转同样可能争用。

曾实现过"按文件 stamp 合并 + `deleted` 墓碑"，复审确认该设计在多写者下不可靠（墓碑与 pin 用两个时钟比较、墓碑被 pin 上限挤出、`delete()` 只对本进程已加载的会话生效、size+mtime 无法区分同长度写入），已整体撤销。正确做法需要单一权威（文件锁 + 只提交本进程增量），复杂度与收益不匹配当前场景：DSH 只有主进程加载插件。变更 home、裁剪或丢失 pin 后会重新决策；这不恢复代理状态。

[安装辅助脚本](<scripts/install-profile.mjs>)与运行时存储分开：默认 profile 路径不读取 `DSH_HOME`，脚本使用 Windows 应用 runtime 探测。修改 profile 前通过[锁文件转换器](<scripts/profile-lock.mjs>)严格校验 YAML，并完整移除目标 importer/package/snapshot 块；仅全新安装可没有旧记录。自动备份 manifest、lock 和将被覆盖的同名旧 tarball，但没有事务式自动回滚；完整备份、关闭桌面应用、同快照恢复并用应用 runtime 重装仍是操作方责任。脚本不自动关闭/重启应用。

## 4. 安全边界

- 受信 origin 的 `detach` 删除当前配置的三个身份头及 DSH 会话头（无论 `sessionHeader` 开关状态）；`skip` 不改已有头。会话头**并非本插件独有**：DSH 核心在 Anthropic 形状请求上也会写 `x-deepseek-harness-session-id`，摘链仍刻意删除它——否则代理仍能把这次调用归到某会话，摘链就名不副实；这是唯一一处有意触碰非本插件设置的头。任意额外头不清除，因此摘链不是完整清洗。
- attach 使用 `Headers.set`，可覆盖同名现有头；任意额外头不是受限的 memory-only 命名空间。审查其可信度，避免误覆盖认证/路由头。
- 白名单是客户端出站头决策边界，不验证目标服务器身份或重定向后目的地。使用正确的受信 origin 与传输保护，代理协议仍需部署方验证。
- 配置中可含敏感头值；日志虽不写这些值，却写身份/session ID 和原始 baseURL（可能含凭据或查询参数）。分享前脱敏，按敏感运行数据控制访问。
- 插件不读取记忆仓，但会读写本地配置/pin/诊断。不可宣传“不落盘”或“无隐私数据”。
- 无预算、token 计数、流拦截、记忆内容过滤、代理隔离或代理状态恢复能力。服务端 bypass/注入/写入不是客户端可保证的结果。

## 5. 测试覆盖与验收分层

| 证据入口 | 覆盖范围 |
| --- | --- |
| [身份测试](<tests/identities.spec.ts>) | normalize、校验问题码、ID/模型选择、URL 模式、头组装 |
| [决策测试](<tests/gate.spec.ts>) | skip/detach/attach、pin 优先、快照复现、旧 pin 迁移、非法值不固化、摘链头名并集、会话头、无 session、辅助请求 |
| [存储测试](<tests/store.spec.ts>) | pin 与快照往返/删除/裁剪、快照严格解析与写时规则、迁移标记一致性、坏文件保留副本、首写/防抖、追加顺序、目录消失、轮转 |
| [Host 测试](<tests/host.spec.ts>) | 模拟 Context 上事件注册、实际 Headers、坏行、配置读取、日志/dispose、旧 pin 迁移落盘、非法值不固化、重命名后摘链清理、两种配置校验形状、旧服务、真实 Schemastery resolve |
| [脚本测试](<scripts/ci.test.mjs>)、[安装测试](<scripts/install-profile.test.mjs>)、[发布测试](<scripts/release-gate.test.mjs>)、[发布策略测试](<scripts/release-policy.test.mjs>) | CI/安装/发布脚本的行为或静态约束；不代替真实安装 |
| [产物检查](<scripts/package-artifact.mjs>) | tarball 清单、严格 peer 消费安装、host import、公开类型、client wrapper；需要安装依赖 |
| [Smoke](<scripts/smoke.mjs>) | 构建产物 + 模拟 Context 的决策样例，临时 DSH_HOME |

[卡片交互测试](<tests/client-card.spec.tsx>)使用 jsdom、真实 React root 与模拟 Remote 边界，覆盖草稿复原、dirty revision 保留、读取失败/重试、保存后刷新失败、过期读取、保存与失效竞争及卸载；不覆盖宿主 DOM 注入或真实网络。

[模型选择器测试](<tests/client-select.spec.tsx>)覆盖默认/摘链/指定身份、保存失败和异步目标隔离；[DOM 注入测试](<tests/client-injector.spec.ts>)用宿主结构 fixture 覆盖锚点、staging、挂载清理和过期读；[写入测试](<tests/client-ops.spec.ts>)验证字段保留、冲突重读和只读拒绝。fixture 不能替代真实宿主版本的页面验收。

源码中的测试用例存在，不等于某次执行已通过。报告应列出实际执行命令与结果，不能仅引用测试名称。当前列出的 host/纯逻辑测试和产物 wrapper 检查均不足以证明浏览器已渲染卡片/下拉框，也不能证明代理注入或记忆写入。真实验收应分别保留宿主加载、UI 交互、实际出站头和代理结果的证据；合成测试必须用隔离存储，避免污染真实 session pin。
