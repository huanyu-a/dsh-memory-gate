# 部署清单（desktop profile）

本文件是**操作清单**，不是设计文档。背景见 [README](<README.md>) 的「安装、升级与回滚」。
只在一台机器、一个 profile 上执行；每一步都有可验证的判据，不要跳步。

- 目标 profile：`C:\Users\WIN11\.dsh\profiles\desktop`
- 仓库：`D:\project\dsh-profile\dsh-memory-gate`
- 版本号：`0.1.0`（**与已装版本相同**，所以不能用版本号判断是否装上了新构建，见第 3 步）

## 0. 先确认要装的是什么

已装的是旧构建（无 `trustedOrigins` / `removeHeaderNames` / `migratedAt`）。装完后这三样都应该出现：

```powershell
$p = "C:\Users\WIN11\.dsh\profiles\desktop\node_modules\dsh-memory-gate\lib\index.js"
(Select-String -Path $p -Pattern 'trustedOrigins','removeHeaderNames','migratedAt' -SimpleMatch | Measure-Object).Count
```

装前输出 `0`；装后应为正数。**不要死记具体数字**——它随代码改动漂移（本构建实测为 18：`trustedOrigins` 10 行、`removeHeaderNames` 5 行、`migratedAt` 3 行，按行×模式计）。判断标准只有两条：装前必须是 `0`，装后必须大于 `0`。

更稳的单点判据（布尔值，不受计数漂移影响）：

```powershell
(Select-String -Path $p -Pattern 'trustedOrigins' -SimpleMatch -Quiet)
```

装前 `False`，装后 `True`。

## 1. 完全退出 DSH

应用运行时会占用 `node_modules/dsh-memory-gate`，且退出时可能重写 profile 清单，装到一半会被覆盖。

```powershell
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Select-Object Id,ProcessName
```

必须**无输出**再继续。有残留就正常退出应用，不要直接杀进程（可能留下写入中的清单）。

安装脚本同样会检查这一点：应用未退出时直接以退出码 1 拒绝执行。如果你的终端就在应用里（关掉终端等于关掉应用），用 `--wait-for-exit` 让它先等：

```powershell
node scripts/install-profile.mjs "C:\Users\WIN11\.dsh\profiles\desktop" --wait-for-exit 300
```

它会先打印等待提示，然后你退出 DSH，脚本在 2 秒内检测到进程消失后自动继续；超过 300 秒则退出码 1 且**不写入任何文件**。不要用 `--allow-running` 绕过。

## 2. 备份 profile

安装器只自动备份 `package.json`、`pnpm-lock.yaml` 和被覆盖的同名 tarball，**不足以整体回滚**。

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
robocopy "C:\Users\WIN11\.dsh\profiles\desktop" "D:\backup\desktop-profile-$stamp" /E /R:0 /W:0
```

**不要用 `Copy-Item -Recurse`**：profile 里 `node_modules/@local/dsh-personal` 是 `link:` 依赖的符号链接，普通权限复制会失败并报 `EPERM: operation not permitted, symlink`（已实测）。`robocopy` 不会失败——它会把该链接**展开成实体目录**复制，所以备份里的 `dsh-personal` 是拍快照那一刻的副本，不指向实时目录。

回滚脚本要求备份内**含已安装的插件目录**（`node_modules/dsh-memory-gate/package.json`），因此整树备份是必需的；只备份 manifest 与 lock 不足以回滚。

## 3. 执行安装

```powershell
cd D:\project\dsh-profile\dsh-memory-gate
node scripts/install-profile.mjs "C:\Users\WIN11\.dsh\profiles\desktop" --dry-run   # 先预演
node scripts/install-profile.mjs "C:\Users\WIN11\.dsh\profiles\desktop"             # 再执行
```

判据：脚本自行重建、打包、替换、按字节比对全部产物，并拒绝嵌套依赖。任何一步失败都会 `fail` 退出，**不要**在失败后启动应用。

预演应打印：`profile`、`pnpm 11.28.5`、`replacing ...\node_modules\dsh-memory-gate`。

## 4. 装后校验（启动前）

一条命令核对全部条件（推荐，比下面几行手工检查更可靠）：

```powershell
node scripts/verify-install.mjs "C:\Users\WIN11\.dsh\profiles\desktop"
```

它逐项打印 PASS/FAIL：profile 结构、插件已装、清单依赖、bundle 注册、**host 与 client 两半都是新构建**、lockfile 记录、pin 文件可读。退出码 0 表示全部通过，1 表示有问题。

pin 文件位置默认从 `src/store.ts` 推导；若在仓库外单独使用该脚本，可用 `--storage=<目录>` 直接指定（目录名是 `memory-gate`，**不是**包名 `dsh-memory-gate`，两者故意不同）。

注意 host/client 的判定不看版本号（升级前后同为 `0.1.0`），而是查新构建特有的标记；client 半边尤其如此——它的模块 wrapper 在两版里完全相同，只查 wrapper 会假通过。

手工检查等价项：

```powershell
Test-Path "C:\Users\WIN11\.dsh\profiles\desktop\node_modules\dsh-memory-gate\lib\index.js"   # True
Test-Path "C:\Users\WIN11\.dsh\profiles\desktop\node_modules\dsh-memory-gate\lib\client.js"  # True
```

## 5. 启动并验证行为

1. 启动 DSH。
2. 打开「设置 → 模型 → 模型选项」，确认记忆身份下拉正常；打开记忆插件卡片，确认能看到「可信来源」（trustedOrigins）多行输入框——旧构建没有这个字段，**看到它即证明新构建已加载**。
3. **逐个模型行展开「模型选项」**，确认每一行下方出现记忆身份下拉。这一步单独做：注入器按宿主 CSS Module 类名定位，类名与元素链已从当前构建的代码核实（按钮在 `modelEntry` 内、展开区是其子元素、外层为 `editor` 卡片），但运行期挂载仍取决于 React 重渲染时机，静态核对不能替代实机。若下拉不出现，控制台会打印一条 `memory-gate` 提示说明是哪些标签没匹配上。
3. 发一条会走记忆链的消息（provider 为 magpie）。
4. 检查决策日志最后一行：

```powershell
Get-Content "C:\Users\WIN11\.dsh\storage\memory-gate\decisions.jsonl" -Tail 1
```

应包含 `reason`（正常挂载为 `attached`，已 pin 的会话为 `pinned`）。

5. 检查 pin 文件是否写入快照（新会话才有）：

```powershell
Get-Content "C:\Users\WIN11\.dsh\storage\memory-gate\sessions.json" | Select-String -Pattern 'snapshot' -SimpleMatch | Measure-Object | Select-Object Count
```

## 5.5 会话被永久摘链时怎么恢复

`no-default-identity` 与 `identity-missing` 会写入 `identity: null` 的 pin，而 pin 一旦写入就不再重新决策——**即使之后修好配置，那些会话也不会自动恢复**。实测日志里曾有三个会话因此连续 396 次空转。

查看当前 pin：

```powershell
node scripts/session-pins.mjs
```

只清除摘链的（保留正常挂载的），或清除指定会话：

```powershell
node scripts/session-pins.mjs --clear-detached
node scripts/session-pins.mjs --clear <session-id>
```

脚本先备份为 `sessions.json.bak-pins-<时间戳>`，并且**在 DSH 运行时拒绝执行**（插件内存里持有整张表，外部改动会被覆盖）。`--dir=` 可指向副本，配合 `--force` 用于演练。

## 6. 回滚

失败后**保持 DSH 关闭**，整份还原，不要只还原 lockfile，也不要靠删 pin 代替回滚：

```powershell
# 先看计划，不写任何文件
node scripts/rollback-profile.mjs --backup "D:\backup\desktop-profile-<stamp>"

# 确认无误再执行
node scripts/rollback-profile.mjs --backup "D:\backup\desktop-profile-<stamp>" --yes
```

脚本会先校验备份确实是可还原的 profile（有 `package.json`、`dsh.profile.bundles` 含本插件、有 `pnpm-lock.yaml`、有已安装的插件目录），并**拒绝在 DSH 仍运行时执行**。还原时把当前 profile 重命名为 `<profile>.pre-rollback-<时间戳>` 而不是删除，所以还原本身也可撤销。

手工等价做法：

```powershell
# 先移开而不是删除：还原本身也应可撤销
Rename-Item "C:\Users\WIN11\.dsh\profiles\desktop" "desktop.pre-manual-<stamp>"
robocopy "D:\backup\desktop-profile-<stamp>" "C:\Users\WIN11\.dsh\profiles\desktop" /E /R:0 /W:0
```

同样避免 `Copy-Item -Recurse`（符号链接会 `EPERM`）；`Remove-Item -Recurse` 也可能在该链接上失败，所以用重命名代替删除。

还原后再启动，确认插件仍加载、请求正常。本地回滚**不能**恢复代理端的记忆状态。

## 已知注意

- 版本号不变，`0.1.0` 覆盖 `0.1.0`；判断依据只能是第 0 步的内容指纹。
- 旧 pin 只存身份 ID，升级后首次主请求才补快照，取的是**当时**配置；旧版本原本用的值从未落盘，无法恢复。
- 新规则更严：额外头行若「与 team/agent/task 配置的头名同名」或「两行同名（大小写不敏感）」，旧版本允许保存，新版本会判为不合法。含这类行的 pin **快照会被丢弃**（pin 本身保留），该会话下次主请求按实时配置重新决定，不再沿用冻结值。你的 19 条 pin 均无快照、也无额外头行，不受影响。
- pin 文件现在会原样保存身份头值与额外头的值，属敏感数据，注意备份目录权限。
- 多进程共享同一 home 时会合并写盘（墓碑防复活），但**无文件锁**，极端并发可丢一次更新。
