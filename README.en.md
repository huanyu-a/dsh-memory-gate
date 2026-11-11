# DSH Memory Gate

[中文](<README.md>) | English | [Maintainer design](<DESIGN.md>)

## Purpose and non-goals

Select named memory identities for DeepSeek Harness (DSH) pi-ai requests and retain the selection per session. The plugin adds headers at the synchronous `llm-pi-ai/request-headers` waterfall. It does not use `llm/stream`, inspect request bodies, implement memory budgets, or count tokens.

- An identity contains `team` / `agent` / `task` and extra headers. Models can inherit the default, select an identity, or detach.
- The Web client provides a **Memory gate** configuration card and a per-model **Memory identity** picker.
- The plugin does not read/write memory content, proxy traffic, open ports/tunnels, or control server-side injection, tiers, or persistence.

**Proxy assumptions are not plugin guarantees.** This design targets proxies that select memory through identity headers and may permanently mark unidentified sessions as bypassed. Verify injection, memory writes, and conversation-header resolution against your own proxy implementation/configuration. The plugin cannot undo proxy state.

**Detach clears core headers only.** On trusted origins it removes the three identity headers (the union of the names pinned at detach time and the current names) plus the DSH session header, not arbitrary extras or authentication headers. Other headers and later middleware can still identify the request; this is not a guarantee of no proxy side effects.

## Installation, upgrades, and rollback

Step-by-step desktop-profile runbook (exit check, backup, post-install fingerprint, behaviour check, rollback): see the [deployment checklist](<DEPLOY.md>) (Chinese).

Requires Node `^22.19.0 || >=24`. The exact CI cohort declared in the [manifest](<package.json>) is DSH `0.2.2-rc.1`, Cordis `4.1.0`, and Schemastery `3.19.0`. Peer ranges and legacy source branches are not evidence that every matching version has been tested.

### Build and install into a regular profile

Run from the repository root; replace the example profile/version as needed:

```sh
npm ci --legacy-peer-deps=false
npm run build
npm pack --ignore-scripts
dsh plugin --profile my-profile add ./dsh-memory-gate-0.1.0.tgz
```

The bundled [composition patch](<cordis.patch.yml>) registers the `memory-gate` row under package name `dsh-memory-gate`. The host loads both halves. Avoid `link:` dependencies in a real profile: they may resolve development dependency copies. Upgrade through the profile's existing package-management mechanism and confirm it consumes the fresh tarball rather than a cached extraction.

### Desktop profile caveats

Desktop profiles are application-managed; prefer the application's plugin installation UI. Do not assume a global CLI uses the desktop kernel. The repository's [installation helper](<scripts/install-profile.mjs>) replaces an existing installation in a Windows desktop environment:

```sh
node scripts/install-profile.mjs --dry-run
node scripts/install-profile.mjs "C:/path/to/profile" --dry-run
# Run only after backing up the profile and closing DSH:
node scripts/install-profile.mjs "C:/path/to/profile"
```

- The default is `.dsh/profiles/desktop` under the user home. **The helper does not derive this path from `DSH_HOME`**; pass a custom path explicitly.
- Dry-run still requires a profile and the bundled Node/pnpm in a location the script probes. It does not prove installation will succeed.
- A real run rebuilds/packs, backs up the profile manifest/lockfile, replaces the tarball, removes the old plugin directory and lock entries, installs with the bundled pnpm, byte-compares all built outputs, and rejects nested plugin dependencies.
- Before profile mutation, the helper strictly parses the lockfile and computes removal of importer/package/snapshot records. Missing old records are allowed only when neither an installed directory nor a declared dependency exists; inconsistent existing installations are rejected. There is no transactional automatic rollback.
- Do not substitute a global pnpm casually: dependency layout/instances may differ. The helper does not close or restart the desktop app or recover a failed installation automatically.

### Safe rollback

Fully exit DSH first. Before changing anything, back up the complete target profile, or at least its manifest, lockfile, old tarball, and relevant configuration. A same-version tarball can be overwritten; the helper's two automatic file backups alone are insufficient for full rollback.

After failure, keep DSH closed. Restore the manifest, lockfile, and old tarball from the **same snapshot**, then reinstall in that profile with the application's original Node/pnpm; alternatively restore the complete profile backup. Start the app manually only after dependencies/configuration are consistent, then check loading and new requests. Do not restore only the lockfile or delete pins as a substitute for rollback. Preserve a plugin-storage backup; local rollback does not restore proxy memory state.

## Configuration

On a supported Web host, open **Plugins → dsh-memory-gate → Memory gate**. The legacy branch uses **Settings → Plugins → Plugin configuration**. This describes the UI implemented in source, **not browser-rendered acceptance verified in this documentation task**.

| Field | Default | Purpose |
| --- | --- | --- |
| `identities` | `[]` | Named `id/team/agent/task/headers` records |
| `defaultIdentity` | empty string | Identity inherited by unspecified models; empty adds no identity |
| `headerNames` | `x-team-id/x-agent-id/x-task-id` | Names of the three identity headers |
| `trustedOrigins` | `["http://127.0.0.1:8096"]` | Exact trusted proxy origins; empty disables all |
| `sessionHeader` | `true` | Add `x-deepseek-harness-session-id` on attach when a session ID exists |

Identity IDs are trimmed and compared case-insensitively. Save validation requires nonempty unique IDs, a nonempty team, and Fetch-representable team/agent/task and extra headers. Reserved model picks `off` / `default` are rejected as identity IDs. The host also requires valid distinct identity header names that do not occupy the session header, and a nonempty default identity must exist. Empty agent/task fields produce no corresponding header. Extra rows are assembled later and can override identity headers; the enabled session header is assembled last.

This is a composition-layer plugin-row example, not a replacement for an entire profile file:

```yaml
- id: memory-gate
  name: dsh-memory-gate
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

Under **Settings → Models**, expand a saved provider and its model's **Model options** (legacy label: **Capacities**), then select Default, Detach, or an identity. Unsaved provider pickers are disabled. The picker writes `memoryGate` on `llm-pi-ai.providers.<provider>.models[]`: `off`, `default`, or an identity ID; Default may remove the field. DOM anchors depend on the host page structure and may stop locating controls after host updates.

### Recognition and session semantics

- Parse the URL and exactly match its origin against `trustedOrigins`, defaulting only to `http://127.0.0.1:8096`. Different protocols, hosts or ports require separate entries. Credential-bearing or non-HTTP(S) request URLs do not match. Entries must be HTTP(S) origins without credentials, paths, query strings or fragments; `[]` disables all origins.
- The first memory-chain request with a session ID and `purpose === undefined` can create a pin. Without a session ID, no pin or session header is created.
- Downgrade caveat: an older build that does not know snapshots rewrites `sessions.json` without `snapshot`/`migratedAt`; after upgrading again those pins re-migrate once against **current** configuration. The file's `version` field is not validated, so this cannot be detected.
- A new pin stores **a snapshot of the identity and header shaping**: its three values, extra rows, header names and the session-header switch. Editing or deleting that identity afterwards does not change the pinned session's headers; new sessions take the new configuration. Model/default changes never override an existing pin.
- A legacy pin holds only an identity ID. The first main request that uses it snapshots the configuration **at that moment** and records `migratedAt`; it is fixed after that. The original values were never persisted and cannot be recovered. If the ID no longer exists the session stays detached (`pinned-identity-missing`). Auxiliary calls never migrate.
- `trustedOrigins` is re-checked against **current** configuration on every request: a pin cannot give an untrusted origin identity headers.
- Auxiliary requests (defined `purpose`) create no pin but reuse existing pins. Without a pin they attach/detach according to current model configuration. **No local pin does not imply no proxy side effects.**
- Unrecognized routes are skipped without changing their headers. Adapters that do not emit this event are outside this plugin's scope.

## Verification and troubleshooting

Storage uses `DSH_HOME` first; otherwise `USERPROFILE`, then `HOME`, with `.dsh` appended. With neither home variable it uses relative `.dsh`. Under that root, `storage/memory-gate` holds:

| Data | Content and limits |
| --- | --- |
| `sessions.json` | Session ID → `identity/reason/at/provider/model`, plus `snapshot` (identity triple, extra rows, header names, session-header switch), the cleanup `removeHeaderNames` (recorded on attach and detach pins when the names are usable, so a rename can still clear the old names), and the migration marker `migratedAt`; synchronous startup read and first dirty-touch write attempt, then 1-second debounce; flush retains the newest 2,000 by `max(at, migratedAt)`, **not LRU** |
| `decisions.jsonl` | `ts/kind/reason/provider/model/session/identity/chain`; diagnostic attach/detach records, no token fields; attempts rotation to `.1` when size is ≥ 2 MiB before append |

These are state/diagnostics, not memory content, but expose identity IDs, session IDs, and URLs; URLs may contain sensitive parameters. **The pin file now stores identity and extra header values verbatim** (a snapshot has to replay them), while `decisions.jsonl` stores neither those values nor request bodies. Treat both as sensitive runtime data, and size for it: snapshots make each pin much larger, so a full 2,000 pins with many extra rows can reach several MiB.

1. Send a main request in a new session on a matching route. Check provider/model/session/identity and the attach or explicit detach reason.
2. Check the matching pin. Change that model to Detach: a new session should use the new pick; the old pin should win if its identity still exists.
3. Inspect received headers through a controlled proxy or server trace, then separately verify proxy injection/writes. **An attach log proves a local decision, not successful stamping of every row or successful server memory.**

Read-only inspection example (set `DSH_HOME` first when using a custom root):

```powershell
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Get-Content (Join-Path $DshHome 'storage/memory-gate/decisions.jsonl') -Tail 5
Get-Content (Join-Path $DshHome 'storage/memory-gate/sessions.json')
```

| Symptom | Check |
| --- | --- |
| No log | Plugin loading, pi-ai event, nonempty provider/model, URL match, writable storage |
| `no-default-identity` / `identity-missing` | Whether the configured default/model identity exists |
| Model change appears ineffective | Existing session pin; verify with a new session |
| Attach but proxy does not recognize it | `gate skipped` warnings, actual names/values, other header overrides, proxy protocol |
| Missing picker | Save provider, expand model options, refresh client, check DOM/slot compatibility |

Unreadable/corrupt storage loses old pins and permits fresh decisions. Write failures warn without guaranteed retry; crashes can lose debounced changes. Eviction, deletion, or changing `DSH_HOME` also loses local pins and cannot revoke proxy bypass. Prefer a new session when changing session policy.

Storage is not profile-scoped. Processes sharing a home share paths but keep separate in-memory maps, with **no cross-process lock and no merge**: a whole-map write can overwrite another process's pins and log rotation can race. Do not treat the shared directory as coordination. An unreadable `sessions.json` is first copied to `sessions.json.corrupt-<timestamp>` instead of being silently replaced.

## Developer commands

Install and build on the same OS/architecture rather than reusing another platform's esbuild binary:

```sh
npm ci --legacy-peer-deps=false
npm run typecheck
npm test
npm run test:scripts
npm run build
npm run pack:check
node scripts/smoke.mjs
```

The package check creates a consumer project and installs dependencies. Smoke uses temporary `DSH_HOME` and a simulated Context; it does not prove real-host/UI/proxy end-to-end behavior. See the [design](<DESIGN.md>) for coverage and compatibility layers. Contribute through a branch and PR with test evidence; do not commit real identities/profile data.

License: [MIT](<LICENSE>).
