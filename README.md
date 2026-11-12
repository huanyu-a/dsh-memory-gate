# DSH Memory Gate

中文 | [English](<README.en.md>) | [维护设计](<DESIGN.md>)

## 用途与非目标

为 DeepSeek Harness（DSH）的 pi-ai 请求选择命名记忆身份，并按会话保存选择。插件在同步 `llm-pi-ai/request-headers` waterfall 中添加身份头；不使用 `llm/stream`，不读取请求正文，不实现记忆预算或 token 统计。

- 身份包含 `team` / `agent` / `task` 和额外请求头；模型可选择默认身份、指定身份或摘链。
- Web 端提供「记忆闸门」配置卡片和模型行「记忆身份」下拉框。
- 插件不读写记忆内容、不代理流量、不新增端口或隧道，也不控制服务端注入、记忆分层或持久化。

**代理约定不等于插件保证。** 此设计面向通过身份头选择记忆、可能把无身份会话永久标记为 bypass 的代理。实际是否注入、写入记忆、如何解析会话头，必须按你的代理配置和实现验证；插件不能撤销代理状态。

**摘链只清理核心头。** 在受信 origin 上，`detach` 删除三个身份头（当时的头名与当前头名的并集）及 DSH 会话头，不删除任意额外头或其他认证头。其他头仍可能让代理识别身份；后续中间件也可重新添加头，因此不保证代理无记忆副作用。

### 通用机制与 TDAI 默认值

按实现，本插件不绑定 TDAI：核心机制是——**按 origin 白名单，给出站模型推理请求（`llm-pi-ai/request-headers` waterfall）按模型选择盖配置头，并把每个会话的首次决策钉住**。头名、头值与受信 origin 全部可配置；接入 TDAI 记忆代理是首个用例与出厂默认，不是硬依赖。

- **通用机制**：`headerNames` 三个槽位可配成任意合法 HTTP 头名；每个身份可带任意额外头行；`trustedOrigins` 接受任何 HTTP(S) origin；模型选择与会话钉住不依赖任何代理协议。
- **仅属 TDAI 用例的默认值**：默认 origin `http://127.0.0.1:8096`、默认头名 `x-team-id` / `x-agent-id` / `x-task-id`、会话头 `x-deepseek-harness-session-id` 的对话键语义，以及「身份 / 记忆」这套措辞。
- **通用使用仍受既有边界约束**：只影响出站推理请求，不碰 DSH 的其他请求；摘链只删三个核心头与会话头，任意额外头不清除（见上）；头值为静态配置，无动态模板；配置改动只对新会话生效（会话 pin 冻结）。

## 安装、升级与回滚

桌面 profile 的分步操作（退出校验、备份、装后指纹、行为验证、回滚）见[部署清单](<DEPLOY.md>)。

需要 Node `^22.19.0 || >=24`。当前[清单](<package.json>)的精确 CI cohort 是 DSH `0.2.2-rc.1`、Cordis `4.1.0`、Schemastery `3.19.0`。peer 范围及源码中的旧版分支不是所有版本均已实测的承诺。

### 安装到普通 profile

包已发布到 npm，直接从 registry 安装；把示例 profile 替换成实际值：

```sh
dsh plugin --profile my-profile add dsh-memory-header-gate
```

需要离线安装时，在仓库根目录构建并打包：

```sh
npm ci --legacy-peer-deps=false
npm run build
npm pack --ignore-scripts
dsh plugin --profile my-profile add ./dsh-memory-header-gate-0.1.1.tgz
```

包内[组合补丁](<cordis.patch.yml>)注册 `memory-gate` 行，包名为 `dsh-memory-header-gate`。由宿主加载 host/client；不要把源码目录用 `link:` 接入真实 profile，以免解析到开发依赖副本。升级沿用该 profile 的包管理方式，并确认使用的是新 tarball，而不是旧缓存。

### Desktop profile 注意事项

Desktop profile 由桌面应用管理，应优先使用应用提供的插件安装入口；不要假设全局 CLI 与桌面内核相同。仓库的[安装辅助脚本](<scripts/install-profile.mjs>)是 Windows 桌面环境下的现有安装替换工具：

```sh
node scripts/install-profile.mjs --dry-run
node scripts/install-profile.mjs "C:/path/to/profile" --dry-run
# Run only after backing up the profile and closing DSH:
node scripts/install-profile.mjs "C:/path/to/profile"
```

- 默认路径为用户主目录下的 `.dsh/profiles/desktop`；**脚本不以 `DSH_HOME` 推导此路径**，自定义目录请显式传入。
- dry-run 仍要求 profile 和脚本所探测的应用内置 Node/pnpm 存在，不证明实际安装一定成功。
- 实际运行会重建、打包，备份 profile 的包清单和锁文件，替换 tarball、删除旧插件目录及对应锁记录，再用应用内置 pnpm 安装，并逐字节检查所有构建输出、拒绝插件内嵌套依赖目录。
- 修改 profile 前会严格解析锁文件，并预先计算 importer/package/snapshot 记录的删除结果。仅在不存在已安装目录和依赖声明时允许没有旧记录的首次安装；已有安装却缺少记录时拒绝继续。没有事务式自动回滚。
- 不要随意用全局 pnpm 重装应用 profile；布局和依赖实例可能不同。脚本不会关闭、重启桌面应用或自动恢复现场。

### 安全回滚

操作前完全退出 DSH，并备份整个目标 profile（至少保留包清单、锁文件、原 tarball 和相关配置）；同版本 tarball 可能被覆盖，脚本自动备份的两份文件并不足以完整回滚。

失败后保持应用关闭：恢复**同一时点**的清单、锁文件及旧 tarball，用该应用原本的 Node/pnpm 在目标 profile 重装；或恢复完整 profile 备份。确认依赖与配置一致后手动启动应用，再检查插件加载和新请求。不要只覆盖锁文件，也不要以删除会话 pin 代替回滚。保留插件存储备份；本地回滚不会恢复代理端记忆状态。

## 配置

在支持的 Web 宿主中，进入「插件 → dsh-memory-header-gate」查看「记忆闸门」卡片；旧版分支使用「设置 → 插件 → 插件配置」槽位。这里描述的是源码实现的 UI，**不是本次浏览器渲染验收结果**。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `identities` | `[]` | 命名身份：`id/team/agent/task/headers` |
| `defaultIdentity` | 空字符串 | 未单独指定的模型继承的身份；为空则不添加身份 |
| `headerNames` | `x-team-id/x-agent-id/x-task-id` | 三个身份头名称 |
| `trustedOrigins` | `["http://127.0.0.1:8096"]` | 精确受信代理 origin；空列表全部禁用 |
| `sessionHeader` | `true` | attach 且有 session ID 时添加 `x-deepseek-harness-session-id` |

身份 ID 去空白后按大小写不敏感比较；保存校验要求 ID 非空且唯一、`team` 非空，并检查 team/agent/task 与额外头的 Fetch 可表示性。`off` / `default` 是模型选择保留值，拒绝作为身份 ID；host 还校验身份头名合法且互异、不得占用会话头名，以及非空默认身份必须存在。空 agent/task 不发对应头。额外头后写，可能覆盖身份头；会话头启用时最后组装。

以下是插件行的组合层示例，不是可直接覆盖整个 profile 的文件：

```yaml
- id: memory-gate
  name: dsh-memory-header-gate
  config:
    identities:
      - id: example-worker
        team: example-team
        agent: example-agent
        task: ""
        headers:
          - name: X-Tenant
            value: example-tenant
    defaultIdentity: example-worker
    headerNames:
      team: x-team-id
      agent: x-agent-id
      task: x-task-id
    trustedOrigins:
      - http://127.0.0.1:8096
    sessionHeader: true
```

在「设置 → 模型」展开已保存的 provider 和模型的「模型选项」（旧标签为「容量」），选择默认、摘链或身份。未保存的 provider 下拉框禁用。下拉框写入 `llm-pi-ai.providers.<provider>.models[]` 的 `memoryGate`：`off`、`default` 或身份 ID；默认选择可移除此字段。DOM 锚点依赖宿主页面结构，更新后可能找不到控件。

### 请求识别与会话生效范围

升级/降级注意：若先降级到不认识快照的旧版本，它重写 `sessions.json` 时会丢掉 `snapshot` 与 `migratedAt`；再升级后这些 pin 会按**当时**配置重新迁移一次。文件 `version` 字段不参与校验，无法据此识别降级。

升级注意：不再按 `tdai` / `memory` 关键词或任意 `:8096` 子串识别。远程代理、localhost 别名、HTTPS 或其他端口需要显式加入白名单；旧 pin 不会绕过白名单。旧 pin 升级后首次使用时会补快照，此后身份编辑不再影响该会话。

- 使用 URL 解析后的 origin 精确匹配 `trustedOrigins`，默认仅 `http://127.0.0.1:8096`。不同协议、主机或端口必须单独加入；请求 URL 带凭据或非 HTTP(S) 时不匹配。白名单条目只能是无凭据、路径、查询或片段的 HTTP(S) origin。`[]` 禁用所有 origin。
- 首个有 session ID、且 `purpose === undefined` 的记忆链请求可以创建 pin；无 session ID 不保存 pin，也不添加会话头。
- 新 pin 保存**身份与头配置快照**：三个身份值、额外头、头名和会话头开关。之后编辑或删除该身份都不改变已钉住会话的请求头；新会话才使用新配置。模型选择和默认身份改变同样不会覆盖已有 pin。
- 旧 pin 只有身份 ID。首次被主请求使用时按**当时**配置补快照并写入 `migratedAt`，此后不再变动。原始历史值从未持久化，无法还原；id 已不存在时保持摘链（`pinned-identity-missing`）。辅助请求不会触发迁移。
- 白名单每次按**当前** `trustedOrigins` 复核，pin 不能让不受信 origin 获得身份头。
- 辅助请求（`purpose` 已定义）不创建也不迁移 pin，但仍复用已有 pin；没有 pin 时按当前模型配置 attach/detach。**没有本地 pin 不意味着代理没有副作用**。
- 未识别路由直接跳过，本插件不修改其头；其他适配器若不触发该事件，本插件就不参与。

## 验证与排错

存储根优先取 `DSH_HOME`，否则取 `USERPROFILE`、再取 `HOME` 并追加 `.dsh`；都没有则使用相对 `.dsh`。其下 `storage/memory-gate` 包含：

| 数据 | 内容与限制 |
| --- | --- |
| `sessions.json` | session ID → `identity/reason/at/provider/model`，以及 `snapshot`（身份三值、额外头、头名、会话头开关）、清理用的 `removeHeaderNames`（头名合法时挂载与摘链都会记录，供改名后清除旧头名） 与迁移标记 `migratedAt`；启动同步读取，首次 dirty touch 同步尝试写入，后续 1 秒防抖；flush 时按 `max(at, migratedAt)` 保留最新 2,000 条，**不是 LRU** |
| `sessions.json` 维护 | `node scripts/session-pins.mjs` 列出/清除 pin；摘链 pin（`identity: null`）不会自行恢复，必须清除后才会重新决策 |
| `decisions.jsonl` | `ts/kind/reason/provider/model/session/identity/chain`；记忆链 attach/detach 的诊断记录，无 token 字段；追加前大小 ≥ 2 MiB 时尝试轮转到 `.1` |

这些是状态/诊断数据，不是记忆内容，但会暴露身份 ID、会话 ID 和 URL；URL 可能带敏感参数。**pin 文件现在会原样保存身份头值与额外头的值**（快照需要原样重放），而 `decisions.jsonl` 不保存这些值和请求正文。两者都需要按敏感运行数据保护，并按大小上限估算体积：快照让每条 pin 显著变大，2,000 条满额且额外头较多时可达数 MiB。

1. 用新会话发出一笔匹配路由的主请求，核对日志中的 provider/model/session/identity；预期 attach 或明确 detach 原因。
2. 核对同 session 的 pin。将模型改成摘链：新会话应按新选择；旧 pin 应优先（前提是身份仍存在）。
3. 使用受控代理或服务端请求追踪核对实际收到的头，再单独核对代理注入/写入行为。**attach 日志只证明本地决策，不证明每行成功盖章或服务端记忆成功**。

只读查看示例（采用自定义 `DSH_HOME` 时先设置该环境变量）：

```powershell
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Get-Content (Join-Path $DshHome 'storage/memory-gate/decisions.jsonl') -Tail 5
Get-Content (Join-Path $DshHome 'storage/memory-gate/sessions.json')
```

| 现象 | 检查 |
| --- | --- |
| 没有日志 | 插件是否加载、是否 pi-ai 事件、provider/model 是否非空、URL 是否匹配、存储目录是否可写 |
| `no-default-identity` / `identity-missing` | 默认值或模型指定 ID 是否存在 |
| 改模型选择无效 | 是否复用旧 session pin；用新会话验证 |
| attach 但代理未识别 | 查 `gate skipped` 告警、实际头名/值、其他头覆盖及代理协议 |
| 下拉框缺失 | 先保存 provider、展开模型选项、刷新客户端；检查宿主 DOM/槽位兼容性 |

读取失败/损坏会失去旧 pin 并重新决策；写入失败会告警但不保证重试，进程崩溃可能丢失防抖中的变更。裁剪、删除或换 `DSH_HOME` 也会失去本地 pin，不能撤销代理 bypass。需要改变会话策略时优先新建会话。

存储不按 profile 隔离：共享同一 home 的进程共享路径但各有内存 Map，**无跨进程锁、无合并**，整表写入可能相互覆盖，日志轮转也可能争用。不要把共享目录当协调机制。若 `sessions.json` 不可读，会先复制为 `sessions.json.corrupt-<时间戳>` 再按无旧 pin 处理，不会静默抹掉原文件。

## 开发命令

在同一个操作系统/架构下安装并构建依赖，避免复用另一平台的 esbuild 二进制：

```sh
npm ci --legacy-peer-deps=false
npm run typecheck
npm test
npm run test:scripts
npm run build
npm run pack:check
node scripts/smoke.mjs
```

打包检查会创建临时消费项目并安装依赖；smoke 使用临时 `DSH_HOME` 和模拟 Context，不证明真实宿主/UI/代理端到端成功。测试范围与兼容性分层见[设计说明](<DESIGN.md>)。贡献请基于分支提交 PR，说明测试证据；不要提交真实身份或 profile 数据。

许可：[MIT](<LICENSE>)。
