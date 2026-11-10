# DSH Memory Gate

中文 | [English](README.en.md)

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：**按模型、按会话决定这一笔请求要不要带记忆身份头**。

它管的是「这一笔请求是否让 TDAI 记忆代理认领它」这件事，而不是记忆本身。记忆的读写、分层（L0/L1/L2/L3）、预算、注入器全在 8096 代理那一侧；本插件只在客户端这一侧，决定请求发出去时带不带 `x-team-id` / `x-agent-id` / `x-task-id` 这组身份头，以及是否带上让代理把整个 DSH 会话当成一个会话的 `x-deepseek-harness-session-id`。

- ✅ 读写的**不是**记忆内容：插件不读、不写、不缓存任何记忆条目，只改请求头。
- ✅ 不是隧道、不是转发、不新增端口：8420 / 8125 **没有**被本插件使用，也没有出现在 `forwards.conf` 里。
- ✅ 不碰平面 B（new-api 公益站）。

## 为什么需要

DSH 的 `magpie` provider 默认把 `baseURL` 指向 `http://127.0.0.1:8096/dsh/default`——那不是 Magpie，而是 **TDAI 记忆代理**。这个代理只有在请求带身份三件套时才做身份预选；一旦某一笔请求没带，它就把该会话记成 `bypassed=true`，而**这是终态**：此后每一轮都 `skipping all injection`，连 L0 都不写。

于是一个具体的问题出现了：

1. **判定层不该被记忆污染。** 路由/看门狗这类做判定的模型，被注入记忆后判定会变（记忆里的旧结论会改写当下判断）。原设计的解法是让它们走别的直连 provider，但那需要额外的 key；**在客户端按模型摘链**是零依赖的等价手段。
2. **会话中途改主意 = 永久失去记忆。** 因为 `bypassed` 是终态，如果第一笔请求带了身份头、第二笔又摘掉，这个会话就再也回不到有记忆的状态。所以「第一笔决定」必须被**钉住**（pin），之后同 `sessionId` 一律复用，配置改动只影响新会话。
3. **DSH 不发会话头，代理就每轮开一个新会话。** 代理认 `x-deepseek-harness-session-id`（`resolveConversationId`），但 DSH 自己不发。补上这一个头，代理才能把一个 DSH 会话当成一个会话。
4. **记忆 + 超长上下文会叠加。** 代理的服务端预算（`tdai.memory.l1Limit` 等）在服务器 YAML 里，客户端无法按请求覆盖。本插件的「预算闸门」是**客户端**闸门：粗估请求体量，超阈值就在会话首笔请求时摘链。

## 特性

- **命名记忆身份**：每个身份 = `team` / `agent` / `task` 三件套（可留空的部分会被省略）+ 任意多组额外头。身份 ID 不区分大小写唯一（`Worker` 与 `worker` 是同一个）。
- **按模型选用**：模型页每行有一个「记忆身份」下拉框，选项是 `默认（随默认身份）`、`摘链（不带身份头）` 和全部身份 ID。选择写入该模型行在 `llm-pi-ai` 里的 `memoryGate` 字段。
- **按会话钉住**：一个会话的第一次决策写入 `sessions.json`，之后同一 `sessionId` 一律复用。**改配置只影响新会话**，正在跑的会话保持它一开始的决定——这正是「摘链要谨慎」的技术原因。
- **默认身份 + 头名覆盖**：没被单独指定的模型一律随默认身份；三个身份头的名字可以改（例如网关把 `x-team-id` 拼成 `X-Team`）。
- **可选的会话头**：默认发送 `x-deepseek-harness-session-id`，可在卡片里关掉。
- **可选预算闸门**：默认关闭。打开后，会话第一笔请求粗估超过阈值就摘链并钉住。
- **只在记忆链上动手**：只有 `baseURL` 指向 8096（或主机名含 `tdai` / `memory`）的路由才会被处理；其它路由**一个头都不加、不改、不删**。
- **落盘可查**：每次决策一行 JSONL，可在事后核对某个会话为什么有/没有记忆。

## 安装

插件与 DSH 版本对应关系：

| 插件版本 | 适配的 DSH 版本 | Cordis | Schemastery |
| --- | --- | --- | --- |
| 0.1.0 | 0.2.2-rc.1 | 4.1.0 | ≥ 3.18.2（实测 3.18.5 与 3.19.0 均可） |

本包自带 `cordis.patch.yml`，组合器会自动挂载 host 半端，并向 Web 客户端提供 `/plugins/dsh-memory-gate/client.js`——安装后无需额外的组合配置。

### 装进 `desktop` profile（本仓实际采用的方式）

`desktop` profile 由桌面应用独占管理，`dsh plugin --profile desktop add …` 会被拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。因此改为把包放进 profile 自己的
依赖表，并用**应用自带的 pnpm** 安装：

```sh
node scripts/install-profile.mjs            # 默认 desktop profile
node scripts/install-profile.mjs --dry-run  # 只看计划，不写盘
```

脚本会备份 `package.json` / `pnpm-lock.yaml`，把依赖写成 `file:dsh-memory-gate-<version>.tgz`、把包名追加到
`dsh.profile.bundles`，然后用应用自带的 pnpm 安装，最后**逐字节比对**装进去的 `lib/index.js` 与本地构建产物，
并拒绝带嵌套 `node_modules` 的安装结果。装完重启桌面应用即可生效。

两条硬约束，脚本已经内建，手工操作时也必须遵守：

- **必须用应用自带的 pnpm**（`%LOCALAPPDATA%\…\dsh-primary-runtime\dependencies\pnpm`，本机为 11.28.5）。
  全局的 pnpm 9 不认 profile 里 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted`，会把 `node_modules` 重装成
  isolated 布局——profile 原本 85 个可见包会只剩 11 个，等同于损坏。
- **不要用 `link:` 依赖**。`link:` 让插件按自己的 `node_modules` 解析依赖，于是它拿到的是开发目录里的
  `@deepseek-ai/schemastery`（3.19.0），而同 profile 其它 bundle 都拿 profile 根的那份（3.18.5）。
  `file:` tarball 交给 pnpm 托管，解析路径与其它插件完全一致。
- **换了 tarball 内容后必须强制重装**。lockfile 里记着 `file:` 依赖的 `integrity`；替换 `.tgz` 而 specifier 不变时，
  pnpm 会打印 `Already up to date` 并原样复用上次的解包目录。`install-profile.mjs` 因此每次都**重新 build + 重新 pack**、
  删掉已安装目录，并把该包在 lockfile 里的两条记录（importer 与 packages）删掉，逼 pnpm 重新计算哈希再解包。

### 其它安装源

```sh
# GitHub（git 源，npm 会跑 prepare 自动构建，要求 Node ^22.19.0 或 >=24）
dsh plugin --profile <profile> add github:<owner>/dsh-memory-gate

# tarball
npm ci --legacy-peer-deps=false && npm run build && npm pack
dsh plugin --profile <profile> add ./dsh-memory-gate-<version>.tgz
```

上面两条适用于非 `desktop` 的 profile。装完重启，用 `bash` 工具跑 `dsh plugin --profile <profile> list`
确认 `memory-gate` 行处于 active。注意全局 `dsh` CLI（本机 0.2.1-rc.2）与桌面应用的内核（0.2.2-rc.1）
版本并不相同，`--dump-config` 也不对 `desktop` 开放，所以核对加载状态请以应用里的「插件」页为准。

## 配置

打开「插件」页 → **dsh-memory-gate** 详情页 → **记忆闸门** 卡片（DSH 0.1.5 上是「设置 → 插件 → 插件配置」里以 `memory-gate` 命名空间为键的卡片）。卡片有五个配置字段（都写在同一份 section 里）：

| 字段 | 含义 | 默认值 |
| --- | --- | --- |
| `identities` | 命名身份列表：`id`、`team`、`agent`、`task` + 额外头行 | 空 |
| `defaultIdentity` | 没有单独指定身份的模型所继承的身份 ID | 空（等于一律摘链） |
| `headerNames` | 三个身份头的名字：`team` / `agent` / `task` | `x-team-id` / `x-agent-id` / `x-task-id` |
| `budget` | `enabled` + `maxRequestTokens`（客户端粗估闸门） | 关闭 / 120000 |
| `sessionHeader` | 是否发送 `x-deepseek-harness-session-id` | 开启 |

保存时由 host 半端校验；非法数据（ID 为空、ID 重复、team 为空、头名/头值不能被 Fetch 表示）会被拒绝并原样反馈，不写盘。

### 使用步骤

1. **建身份**：卡片里点「添加身份」，填身份 ID（例如 `worker`）和 `x-team-id` 对应的团队 ID（**必填**：没有团队的请求代理认为是未识别身份，永远无法注入记忆），按需填 agent / task 和额外头。
2. **设默认身份**：在「默认身份」里选一个身份；不选则所有未单独指定的模型都摘链。
3. **按模型选用**：打开「设置 → 模型」，展开提供方卡片，在模型行的「模型选项」（0.1.5 上是「容量」）折叠区里找到「记忆身份」下拉框：
   - `默认（随默认身份）`：继承默认身份；
   - `摘链（不带身份头）`：该模型一律不带身份头；
   - 某个身份 ID：直接指定。

   未保存的提供方行下拉框是禁用的，请先保存提供方。

### 生效时机

- **按会话钉住**：一个会话的第一笔记忆链请求决定它此后是否有记忆。**之后的配置修改只影响新会话。**
- 头名/额外头/会话头开关在「钉住的 attach」上仍按当前配置解析（身份 ID 复用，头名取当前设置）。
- 非记忆链路由完全不被触碰，配置对它们没有副作用。

## 落盘与验证

数据在 `~/.dsh/storage/memory-gate/` 下（`~` 取 `$DSH_HOME`，否则 `$USERPROFILE`/`$HOME` + `/.dsh`）。只有两个文件，都是本插件自己的诊断/状态数据：

| 文件 | 内容 | 策略 |
| --- | --- | --- |
| `sessions.json` | `sessionId → { identity \| null, reason, at, provider, model }` | 载入同步、首次写立即落盘、其后 1s 防抖、上限 2000 条（按 `at` 丢弃最旧） |
| `decisions.jsonl` | 每笔记忆链请求一行 JSON（`ts/kind/reason/provider/model/session/identity/tokens/chain`） | 追加写；>2MB 轮转为 `.1` |

### 验证配方

1. **看决策**：发一笔走记忆链的请求，然后：

   ```sh
   tail -n 5 ~/.dsh/storage/memory-gate/decisions.jsonl
   ```

   应看到一行 `{"kind":"attach","reason":"attached",...,"identity":"worker",...}`；非记忆链路由不会产生任何行。

2. **看钉住**：

   ```sh
   cat ~/.dsh/storage/memory-gate/sessions.json
   ```

   应看到该 `sessionId` 对应一条 `{ "identity": "worker", "reason": "attached", ... }`（或摘链时的 `"identity": null`）。

3. **验证钉住真的生效**：把某个模型在下拉框里改成「摘链」，然后
   - **新会话**：`decisions.jsonl` 出现 `detach reason=model-detached`，`sessions.json` 出现该新会话的 `identity: null`；
   - **旧会话**：同一 `sessionId` 的后续请求仍是 `attach identity="worker"`（钉住生效，配置改动不追溯）。

4. **验证非记忆链不受影响**：把某个直连 provider（例如 `stepfun`）的请求也跑一遍，`decisions.jsonl` 不新增行（`kind: skip` 的决策不写入磁盘日志，因为它在日志里没有信息量）。

## 配置存储格式

`memory-gate` 名下的用户层（DSH 0.1.7+ 写在 Profile 的 cordis 补丁中本插件行的 `config` 下；DSH 0.1.5 写在用户设置文档的同名命名空间里）：

```yaml
memory-gate:
  identities:
    - id: worker
      team: team-a
      agent: agent-a
      task: task-a
      headers:
        - name: X-Tenant
          value: acme
  defaultIdentity: worker
  headerNames:
    team: x-team-id
    agent: x-agent-id
    task: x-task-id
  budget:
    enabled: false
    maxRequestTokens: 120000
  sessionHeader: true
```

模型行上的选择（写在 `llm-pi-ai` 名下，由下拉框写入，无需手工维护）：

```yaml
llm-pi-ai:
  providers:
    magpie:
      models:
        - id: my-model
          memoryGate: worker   # 或 "off"（摘链）/ "default"（随默认身份）
```

部署方也可以通过插件的 cordis 行 `config:` 预置组合层配置（作为用户层的 base）：

```yaml
- id: memory-gate
  name: dsh-memory-gate
  config:
    identities:
      - id: worker
        team: team-a
        agent: agent-a
    defaultIdentity: worker
```

> 组合层配置**不经过**写时校验（`apply()` 直接读 cordis 行）。一个名字不能被 Fetch 表示的额外头行会在盖章时被单独丢弃并 `console.warn`，其余头（含身份三件套与会话头）照常发送。

## 支持范围与已知限制

- 只对 **pi-ai 适配器**（`llm-pi-ai` 提供方路由，含手工声明的自定义提供方）生效。`dsh-llm-deepseek` 这类直连路由不经过 `llm-pi-ai/request-headers` 这道缝——这本来就是正确的：那条路由没有记忆。
- `llm-pi-ai/request-headers` 是 **同步** waterfall：监听器必须同步执行并调用 `next()`。本插件在这条路径上只做一次 Map 查找和若干次 `Headers.set`；任何异常都 fail-open（加不上头 ≠ 发不出请求）。
- **`bypassed` 是终态，这是本插件最大的风险面**：一旦某个会话在首笔请求上摘了链，它此后无论配置怎么改都不会再获得记忆。删掉 `sessions.json` 里该会话的记录**不会**让代理撤销 bypass，只会让插件重新做一次决策（而代理那边已经记住了）。要恢复记忆，请开新会话。
- 只有**主请求**会钉住会话决策：`purpose` 非空的辅助调用（标题生成、压缩等）仍会带上身份头，但**不会**创建钉住记录——辅助调用不该决定主会话的命运。
- 预算闸门是**粗估**，不是 tokenizer：每 4 个非 CJK 字符算 1 token，每个 CJK 字符算 0.75 token，另加每条消息 8 token 的固定开销。它只回答「这个会话是不是已经很大了」。
- 会话头让代理把 DSH 会话当成一个会话；但它**不**改变 DSH 自己的会话划分，也不改变代理的 L0/L1/L2/L3 分层与注入器配置——那些都在服务器 YAML 里。
- 8420 / 8125 未被使用；插件不新增隧道、不转发流量、不落地任何记忆内容。
- 下拉框通过 DOM 锚定注入到官方模型页每行的「模型选项」折叠区（0.1.5 叫「容量」；官方槽位没有模型行级扩展点）。页面结构若变化，插件会停止注入而不影响页面本身；折叠的模型行不渲染该容器，也就没有下拉框，展开即出现。

## 开发

```sh
npm ci --legacy-peer-deps=false  # 严格按锁文件安装并校验宿主 peer
npm run typecheck   # 类型检查
npm test            # vitest：纯逻辑 / 决策矩阵 / 落盘 / host seam
npm run test:scripts # CI 矩阵、失败汇总与发布门禁测试
npm run build       # 产出 lib/index.js（host）、lib/client.js（web）、类型声明
npm run pack:check  # 打包并以精确 cohort 严格消费产物与公开类型
node scripts/smoke.mjs        # 人工过一遍决策矩阵的九条分支（跑 build 之后）
npm run install:profile       # 装进 desktop profile（见「安装」）
```

Windows 上有两处只在这里才会踩到：`scripts/*.mjs` 调用 `npm` / `tar` 时需要 `shell: true`（它们是 `.cmd`
shim），而 `node -e …` 不能走 shell（`cmd.exe` 会重解析里面的引号和括号）；`tar -tf` 输出 CRLF，按行比对前要归一化。
另外本仓的 `node_modules` 里 `esbuild` 的平台二进制必须是 win32-x64——用 WSL 装过依赖后要在 Windows 侧重装，
否则 `npm run build` 会报 "You installed esbuild for another platform"。

`scripts/smoke.mjs` 会把 `$DSH_HOME` 指到临时目录再 `import` 产物，所以它不会碰你真实的
`~/.dsh/storage/memory-gate/`。手工验证时请照此办理，否则合成的 session id 会被钉进真实
`sessions.json`。

测试全部位于 `tests/`：

| 文件 | 覆盖 |
|---|---|
| `tests/identities.spec.ts` | section 默认值与强制转换、全部校验问题码（大小写不敏感重复 ID、空 team、非法头名/头值）、`identityHeaders` 组装、`estimateTokens`（CJK vs 拉丁）、`isMemoryChain`、`parsePick` |
| `tests/gate.spec.ts` | 决策矩阵：非记忆链 skip、模型摘链、无默认身份、身份缺失、attach（含会话头）、钉住优先、钉住身份被删、预算超限、钉住摘链保持、无 sessionId 不钉、辅助调用不钉 |
| `tests/store.spec.ts` | 临时目录里的 pin 往返、按上限裁剪、损坏文件降级为空、首次写同步落盘、后续写防抖、决策日志建目录、**批量追加按调用顺序落盘**、目录中途消失不报错、轮转 |
| `tests/host.spec.ts` | 假 cordis Context 上的 apply()：监听器注册、`Headers` 实际取值、非记忆链不改头、坏行只丢一行、fail-open、决策日志与单次播报、dispose 时落盘、写时校验两种 cordis 调用形状、0.1.5 命名空间注册，以及**真实 schemastery 对 `Config` 的 `resolve`**（空/完整/部分三组输入） |

最后那组 schema 测试不是凑数：`apply()` 是内核**在校验之后**才调用的，只测 `apply()` 永远碰不到 schema 层，
一个"能构建但 resolve 不了"的 `Config` 会带着全绿的测试装进 profile 然后在内核里炸。

它还有一层用处：我一度误判 schema 构建错了，正是这组测试按正确签名调用 `resolve`、证明 schema 一直是好的，
才把结论拉回正轨——真正的错误在我自己写的探测里（`Schema.resolve` 参数顺序传反）。完整复盘见 `DESIGN.md` §7.1。

CI 仅在 PR 和 `v*` 标签推送时运行。PR 从 `package.json` 的 `dshCompatibility` 读取精确 DSH/Cordis/Schemastery 矩阵，在 Node 22、24 上运行静态、单元与打包检查；标签独立执行发布门禁、显式构建和 npm OIDC 发布，不重复运行测试。CI 不上传 artifacts 或创建 GitHub Release。

## 许可

[MIT](LICENSE)