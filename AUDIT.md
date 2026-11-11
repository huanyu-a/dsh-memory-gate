# 全项目复审 — 2026-11-11

## 范围与证据边界

覆盖 host/client 源码、测试、安装/打包/发布脚本、清单、CI 与文档。两条独立只读审查分支分别检查运行逻辑与交付链；维护者复核代码并执行回归。报告不等于代理服务审计，也不构成浏览器端到端验收。此次没有部署、提交或推送。

此前“bundle 中存在卡片字符串即卡片正常渲染”的结论撤回：只能证明产物包含代码。此前真实日志证明旧精简版本运行到 attach/pinned 分支，不证明服务端注入成功。

## 已修复

### A01 [MAJOR] 安装器删除锁记录时遗留块内容

[旧安装器](<scripts/install-profile.mjs>)共享 skipping 状态，package/snapshot 标题删除后，内部四空格字段仍被保留，造成相邻映射污染与重复键。pnpm 的重建掩盖了问题。

改为[纯转换器](<scripts/profile-lock.mjs>)：通过 YAML AST 结构化删除 importer/package/snapshot 记录，严格解析并拒绝重复键；所有 profile 修改之前预先完成转换。已有安装没有旧记录时拒绝，真正全新安装允许缺失记录。增加[fixture 测试](<scripts/profile-lock.test.mjs>)覆盖引号、相邻记录保留、snapshots、重复键和缺失记录。安装器额外备份将被覆盖的同名 tarball，并在启动时检查应用是否仍在运行（运行中直接拒绝；`--wait-for-exit [秒]` 可先等待退出后再装，超时不写入；`--allow-running` 为显式绕过）；仍不提供事务回滚。

### A08 [MAJOR] 身份与配置写时校验遗漏

[身份校验](<src/identities.ts>)原先只要求 team 非空，不验证 team/agent/task 的 Fetch 可表示性，且允许 off/default 保留 ID。host 也缺少头名互异、会话头碰撞和默认身份引用检查。现已补齐；身份测试从 47 增至 100+（当前全量见「本次验证」）。错误信息只标字段名，不回显身份值。

**三个配置头名仅差大小写时不得重复（已修，装配层兜底）**：`assertValidSection` 会拒绝 `headerNames` 中大小写重复的名字，但该检查同样只覆盖写路径，组合 base 仅告警。实测 `team:'X-Same'`、`agent:'x-same'` 会各写一次，同一个头在线上出现两个值。现 `identityHeaders()` 按大小写不敏感去重，优先级固定为 team > agent > task。

以上四类同源缺陷（行撞身份头、行撞行、配置名撞会话头、配置名互撞）现由 `tests/composition-invariants.spec.ts` 的穷举式属性测试统一看护：遍历 1000 种头名组合，断言「同一头名最多一个值」「会话头下绝不出现常量身份值」「每个被丢弃的行都有对应问题码」。该测试已用变异验证——移除去重逻辑即变红。

**请求路径上的诊断输出不得击穿 fail-open（已修，部署前审查发现）**：请求处理器 catch 块里唯一的动作是 `console.warn`。当宿主 stdout/stderr 已损坏（管道断开时 Node 同步抛 `EPIPE`、控制台脱离、日志重定向失效），该 warn 自身抛错，异常从 waterfall 监听器逃逸，`return next()` 执行不到——**模型调用因插件试图报告问题而失败**。实测：`next calls = 0`、`threw = "EPIPE: broken pipe, write"`，而身份头其实已正确盖上。修复：新增 `report(level, message)`，所有请求路径诊断（组合 base 警告、不可盖章行警告、决策播报、catch 兜底）统一走它，内部 try/catch 吞掉任何抛出；`store.flush` 的失败警告同样加固。修复后同场景 `next calls = 1`、`threw = null`。已用变异验证：把 `report` 换回裸 `console.warn`，测试立刻变红。

**身份字段不得占用传输层头名（已修，审查发现）**：`headerNames` 原先只校验「合法 HTTP 名 + 三者互不重复 + 不撞会话头」，因此可配成 `authorization`。实测后果：attach 会把团队值写进 `authorization`，顶掉调用方自己的 Bearer；detach 会把 `authorization` 列入删除集，直接删掉用户凭据（实测 detach 后 headers 从 `{authorization:'Bearer real'}` 变成 `{}`）。现 `assertValidSection` 拒绝 `authorization`/`cookie`/`host`/`content-type`/`content-length` 等十个传输层头名，`identityHeaders()` 与 `decideGate()` 的删除集也各自再兜底一次，使绕过校验的路径同样不会覆盖或删除凭据。

**写盘失败不得残留临时文件（已修，审查发现）**：`flush()` 先写 `.tmp-<pid>` 再 rename；rename 失败时只把 `dirty` 置回 true，未清理临时文件，每次失败残留一个，进程生命周期内累积。现 catch 内补一次 `rmSync(..., {force:true})`（自身再套 try/catch，清理失败不影响重试）。

**配置头名不得撞上会话头（已修，装配层兜底）**：`headerNames.team/agent/task` 若被设为 `x-deepseek-harness-session-id`，`assertValidSection` 会抛错，但组合 base（`cordis.patch.yml`）在启动时**只告警不抛出**，该配置仍进入运行时。实测后果：会话头开关开启时 team 值被会话头覆盖而丢失（代理视为无 team，记忆永不注入）；开关关闭时 team 值被写成**常量对话键**，所有会话被并成一条代理对话——正是 `name-reserved` 为额外行防的那个后果。现 `identityHeaders()` 把与会话头同名的配置名视为不可用：跳过该字段，因此开关开启时仍发出正确的会话头，关闭时不发出任何常量值。

**额外头行之间不得重名（已修，两道防线）**：两行同名时 `validateIdentities` 原先不检查行间重复——完全同名时后一行静默覆盖前一行，仅大小写不同时（`x-dup` / `X-Dup`）两行都会被写出，因头名大小写不敏感而构成重复头，服务端取值未定义。现新增 `name-duplicate` 问题码（大小写不敏感，拦保存并给 UI 文案）；`identityHeaders()` 同时按大小写不敏感去重、保留首个拼写，故绕过校验的路径也只发出一个值。

**额外头行不得静默覆盖身份头（已修，两道防线）**：额外头行若与 `team/agent/task` 配置的请求头同名，`validateIdentities` 原先返回空问题列表，而 `identityHeaders()` 里「先写身份三件套、再写额外行」的顺序让额外行**静默覆盖**它——编辑器显示 team 是 A，线上发出的是 B；因 HTTP 头名大小写不敏感，`X-Team-Id` 与 `x-team-id` 还会各发一次，形成重复头。现新增 `name-conflict` 问题码（大小写不敏感，命中即拦保存并给 UI 文案），并调整装配顺序：身份字段最后写入，同时丢弃占用已配置名义的行，因此绕过校验的路径也只会发出单一、正确的值。

**额外头行不得占用会话头名（已修，两道防线）**：`validateIdentities` 原先只检查行名的可表示性，一行 `x-deepseek-harness-session-id` 能通过全部校验；当会话头开关关闭时，该行就是对话键，固定值会把所有挂载该身份的会话并成一条，且快照会把它永久固化。现新增 `name-reserved` 问题码并配 UI 文案（大小写不敏感）。第二道防线在 `identityHeaders()`：组合 base 绕过设置写时校验，但仍会在装配请求头时丢弃该行，因此任何路径都无法用它充当对话键。设置卡片也在保存前拦截（保留名、重复名、非法名），并在保存按钮旁显示被禁用的原因——此前原因藏在折叠的身份里。

**组合 base 入口已补提示（未部署）**：`apply()` 启动时对组合 base 跑一次完整校验，不通过则用 `console.warn` 指出是哪一处配置块有问题；**不抛错、不阻断加载**，单个请求仍按 fail-open 走。此前该入口没有任何校验，运维只能看到"没有身份头"的症状而看不到原因。运行时逐行盖章与先 pin 后盖章的风险仍存在，不能把写时修复说成所有入口都已安全。

## 需修复或明确设计决策

### A02 [MAJOR] detach 不能清除已有身份

**已按用户确认策略修复（未部署）**：[Gate](<src/gate.ts>)为受信 origin 的 detach 返回核心删除列表，[Host](<src/index.ts>)先删除当前配置的 team/agent/task 头和 DSH 会话头；不清除任意额外头。skip 原样保留头。实际 Headers 回归覆盖 off、已有 null pin、sessionHeader 关闭、额外头保留及不受信请求不改动。其他头和后续中间件仍可能携带身份，不能宣称代理完全隔离。

### A03 [MAJOR] URL 启发式不是可信代理识别

**已按用户确认策略修复（未部署）**：[识别器](<src/identities.ts>)改为 URL.origin 精确匹配 trustedOrigins，默认仅 http://127.0.0.1:8096；显式 [] 全部禁用。拒绝非 HTTP(S)、凭据、无效格式；配置项拒绝非根路径、查询和片段。客户端可逐行编辑且保存保留空列表。测试覆盖子串伪装、主机/端口/协议、规范化、凭据和自定义 origin。远程代理与 localhost 别名必须显式配置，旧 pin 不绕过白名单且不迁移。重定向、代理自身身份和服务器行为仍不是该白名单能保证的。

### A04 [MAJOR] pin 曾是 ID 引用，不是身份快照

**已按用户确认方案修复（未部署）**：[Gate](<src/gate.ts>)新 pin 深拷贝保存身份三值、额外头、头名和会话头开关，已完成快照的 pin 不再读取实时配置，因此编辑/删除身份不会改写已钉住会话。旧 ID-only pin 由**主请求**首次使用时按当时配置补快照并写 `migratedAt`，此后冻结；原历史值未持久化、无法还原，ID 缺失仍保持摘链，辅助请求不迁移。

复审追加修复的四个新边：①`migratedAt` 曾只写不读，快照被拒后记录仍会重新跟踪实时配置——现在迁移标记必须伴随有效快照，否则整条丢弃；②快照解析曾把每一字段静默降级为空串，可能丢掉 team 或用保留会话头传 team 值——现在要求所有字段类型完整，并复用写时规则校验头名（不得占用会话头/重复/为空）；③非法组合 base 值会被永久固化——现在只在值合法时写快照，修复配置后旧会话仍可迁移；④迁移保留原始 `at` 会被同轮裁剪淘汰——现在裁剪按 `max(at, migratedAt)` 排序，迁移成果不会被立即丢弃。[存储](<src/store.ts>)原样往返 snapshot。回归覆盖编辑后旧会话不变/新会话取新值、重启后持久化、快照身份被删仍可复现、辅助请求不迁移、宿主级迁移落盘、非法值不固化且修复后可迁移。

未解决：迁移时的“当时配置”可能已不同于会话最初使用的配置；这是设计上无法消除的，文档已声明。

### A05 [MAJOR] 有界 pin 存储不能保证会话终身一致

[Store](<src/store.ts>)flush 时按 `max(at, migratedAt)` 保留最新 2,000 个 pin，活跃旧会话仍可能被裁剪；被裁剪的会话下次请求按**当前**配置重新决定（不会恢复旧快照）。

**跨进程合并已尝试并撤销（未部署）**：曾实现按文件 stamp 合并 + `deleted` 墓碑，独立复审确认该设计在多写者下不可靠——墓碑与 pin 用两个时钟比较、墓碑被 pin 上限挤出、`delete()` 只对本进程已加载的会话生效、`size+mtime` 无法区分同长度写入（实测 1,774/2,000 次碰撞）。继续打补丁只会增加失效模式，故整体回退到单写者整表写入，并在文档明确不支持多进程协调。收益本就有限：DSH 只有主进程加载插件。

**保留的两处存储安全修复**：①写入失败不再丢变更（`dirty` 在 `rename` 成功后才清除，失败则置回 true 等下次重试）；②`sessions.json` 不可读时先把原文件复制为 `sessions.json.corrupt-<时间戳>`，避免下一次 flush 把解析失败的文件整体抹掉。

**容量仍为 2,000 条、非 LRU**：被裁剪的会话下次请求按当前配置重新决定，不会恢复旧快照；快照只保证内容不随配置漂移，不保证会话终身保留。

### A06 [MINOR] 客户端草稿与读取错误

**已修复（未部署）**：[卡片](<src/client/MemoryGateCard.tsx>)在编辑恢复原值时同步清除草稿与 ref；读取拒绝或 namespace 缺失显示可访问的告警和重试按钮。确认保存成功后先显示已提交值并清除旧 revision，若刷新失败则不把已提交值误标为未保存；取得新 revision 前禁用后续编辑。dirty draft 仍保留原 revision，冲突不会自动覆盖。通过[17 项 jsdom 交互回归](<tests/client-card.spec.tsx>)覆盖正常、失败、恢复、过期读、保存/失效竞争、卸载及白名单编辑保存。

### A07 [MINOR] 客户端行为与兼容性覆盖不足

现有[测试配置](<vitest.config.ts>)已执行 host/gate/store/identities 与卡片交互回归，并新增[模型选择器 19 项](<tests/client-select.spec.tsx>)、[DOM 注入 28 项](<tests/client-injector.spec.ts>)和[写入操作 6 项](<tests/client-ops.spec.ts>)行为测试。修复选择器写入异常未捕获、目标切换异步状态串扰，以及 provider 无法解析时旧挂载残留；写入前新读取为只读时拒绝 mutate。真实宿主页面仍缺少端到端覆盖，jsdom fixture 不能证明当前宿主 DOM 契约一致。产物 wrapper 检查不是 UI 测试。新增的产物加载测试按宿主的 `__ModuleLoader__.load({id, factory})` 协议真实执行 `lib/client.js` 并调用 `apply`，覆盖注册名、导出面、样式/词典注入与 effect 释放，但仍不渲染组件、不连真实 Remote。

**对本机 DSH 4.x 构建的静态核对（2026-11-11）**：从 `resources/app.asar` 提取当前版本的真实类名映射，注入器依赖的类名全部存在——`editor`/`editorHeader`/`editorRoute`/`editorTitle`/`rowCard`/`addCard`/`rowName`/`modelEntry`/`modelAdvanced`，均为 CSS Module（如 `jrmgQW_modelAdvanced`），`[class*=…]` 子串匹配成立。本地化命名空间 `settings.models` 确实由 models 插件拥有，中文词典含 `modelAdvanced: "模型选项"`、`modelId: "模型 ID"`，因此 `ctx.locale.bind('settings.models')` 能取到中文 aria-label，中文界面不会因标签不匹配而漏挂载。幂等守卫用的 `data-plugin` 由本插件 wrapper 自身通过 `dataset['plugin']` 设置，不依赖宿主。

**元素链已从构建代码核实**：容量按钮（`aria-label` 为 `模型选项 <序号>`，`className` 为 `iconButton`）位于 `div.modelEntry[data-row-key]` 内；展开区 `div.modelAdvanced` 是 `modelEntry` 的子元素（`row.querySelector` 可命中）；`modelEntry` 在 `AnimatedRows.modelList` 内，再外层就是 `div.editor`。`editor` 系列仅 5 个类名（`editor`/`editorHeader`/`editorRoute`/`editorTitle`/`editorActions`），其中 `editorHeader`/`editorTitle`/`editorRoute` 都在卡片头部，不在按钮的祖先链上，因此 `closest('[class*="editor"]')` 会正确落在 `div.editor` 卡片上。

**仍需实机确认的部分**：静态结构正确不代表运行期一定挂载（React 重渲染时机、`AnimatedRows` 的中间包裹元素、展开动画期间 DOM 存在性）。首次部署仍应逐行展开确认下拉出现。peer 范围比清单的精确 CI cohort 宽，旧版本分支不能视为都已实测。文档已区分安装允许范围与验证范围。

## 会话永久摘链不可恢复（已补工具，非缺陷）

`no-default-identity` / `identity-missing` 写入的 `identity: null` pin 与正常 pin 一样不可变，因此一次配置失误会让会话永久留在摘链状态，`SessionStore.delete()` 也从无调用方。真实日志证据：2026-11-10 10:11 起因缺默认身份，三个会话在 55 分钟内累计 396 次空转，直到手工清理 `sessions.json` 才恢复。

这是 pinning 语义的必然结果（代理的 bypass 被视为终态），不是逻辑错误，但缺少恢复手段本身就是可用性缺陷。现补 `scripts/session-pins.mjs`：列出 pin、按会话或按摘链状态清除，写入前备份，DSH 运行时拒绝执行。文档见 `DEPLOY.md` 5.5 与 README 存储表。

## 需要上游验证的事项

- 辅助请求不创建本地 pin，但仍使用 session ID 发请求；是否先于主请求使代理 bypass，需按代理 conversation ID 规则实测。
- Host 对 provider override 的优先级是否遗漏组合层继承，需用真实宿主提供的 partial override fixture 验证。
- 安装器无全事务回滚；新 fixture 证明锁转换，不证明所有真实 profile 安装路径。
- 日志包含 baseURL/session ID；URL 查询参数可能敏感。需要按使用环境选择脱敏规则。
- 摘链已改为删除"当时 ∪ 当前"头名（旧版 null pin 无该字段，仍只删当前名）；任意额外头始终不清除，因此摘链仍不是完整请求头清洗。
- 快照使每条 pin 显著变大（额外头行数无上限）。实测 2,000 条（每条含完整快照与 3 个额外头行）约 1.26 MiB、首次同步加载约 53ms（一次性开销，`tests/store.perf.spec.ts` 可复现）；额外头更多时会继续增长。若实际规模逼近上限，需要为快照加长度/行数预算，或改为按需读取。

## 文档与交付

[中文 README](<README.md>)、[英文 README](<README.en.md>)与[设计说明](<DESIGN.md>)已重写，分别覆盖安装操作、配置参考、验证排障和维护契约。风险与现状明确披露，不用文档替代必要修复。

未经用户另行确认，不把本次审查中涉及身份隔离、会话迁移、可信 origin 的策略变化部署到真实 profile。

## 本次验证

- 单元与组件交互测试：308/308 通过（卡片 17、选择器 19、DOM 注入 30、写入操作 8、产物加载 3、容量实测 1、组合不变量 3、身份 109、Gate 49、Host 34、Store 30）。
- 脚本测试：47 通过、1 跳过、0 失败（安装 7、回滚 11、lockfile 5、发布门禁 4、发布策略 2、pin 维护 7、装后校验 6、CI 5＋1 跳过）。
- TypeScript 类型检查与声明生成通过；host/client 构建与模拟 Context smoke 通过。
- git diff --check 通过。
- 未重跑联网消费者安装、真实 profile 部署或浏览器 UI 端到端验证；上次安装的精简版不包含此次新增修复。
- WSL 对 Windows 挂载盘呈现 49 个 644→755 模式差异；本次未批量 chmod 或修改 Git 全局配置，内容 diff 使用 core.filemode=false 审查。提交前应在目标平台确认模式，避免纳入无关变更。

