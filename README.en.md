# DSH Memory Gate

[中文](README.md) | English

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that decides, **per model and per session**, whether a request carries the memory identity headers.

It governs one question: does this request let the TDAI memory proxy claim it? It does not manage memory. Reading and writing memory, the L0/L1/L2/L3 tiers, budgets and injectors all live on the 8096 proxy side. This plugin works only on the client side: it decides whether the outgoing request bears `x-team-id` / `x-agent-id` / `x-task-id`, and whether it carries `x-deepseek-harness-session-id`, which makes the proxy treat one DSH session as one conversation.

- It does **not** read or write memory content: no memory entries are read, written or cached. Only request headers change.
- It is not a tunnel or a forwarder and opens no port: **8420 / 8125 are not used** and do not appear in `forwards.conf`.
- It does not touch plane B (the new-api public-goods gateway).

## Why

DSH's `magpie` provider normally points its `baseURL` at `http://127.0.0.1:8096/dsh/default` — not Magpie, but the **TDAI memory proxy**. That proxy only performs identity pre-selection when a request carries the identity triple. The moment a request arrives without it, the proxy records the session as `bypassed=true`, and **that is terminal**: every later turn logs `skipping all injection`, and not even L0 is written.

So a concrete problem appears:

1. **Judgement models must not be polluted by memory.** Router/watchdog-style models change their judgement when injected memory rewrites the present decision. The original design routed them to other direct providers, but that needs extra keys; **detaching memory per model on the client** is the zero-dependency equivalent.
2. **Changing your mind mid-session costs memory permanently.** Because `bypassed` is terminal, a session that carried identity headers on its first request and dropped them on its second can never return to having memory. The first decision must therefore be **pinned**, and every later request of that `sessionId` reuses it; configuration changes only affect new sessions.
3. **DSH sends no session header, so the proxy starts a new session every turn.** The proxy reads `x-deepseek-harness-session-id` (`resolveConversationId`) but DSH never sends it. Adding that one header lets the proxy key one DSH session as one conversation.
4. **Memory plus a long context stack up.** The server-side budgets (`tdai.memory.l1Limit` and friends) live in the server's YAML and cannot be overridden per request from the client. This plugin's budget gate is a **client-side** guard: it coarsely estimates the request and detaches on the session's first request when the estimate is already too large.

## Features

- **Named memory identities**: each identity is a `team` / `agent` / `task` triple (empty parts are omitted) plus any number of extra header rows. Identity ids are unique case-insensitively (`Worker` and `worker` name the same identity).
- **Per-model selection**: every model row on the Models page carries a **Memory identity** dropdown offering `Default (follow the default identity)`, `Detach (no identity header)`, and every identity id. The pick is written to that model's `memoryGate` field in `llm-pi-ai`.
- **Per-session pinning**: the first decision of a session is written to `sessions.json` and reused for every later request with the same `sessionId`. **Configuration changes only affect new sessions**; a live session keeps what it started with — the technical reason detaching deserves care.
- **Default identity and header-name overrides**: models not named individually inherit the default identity; the three header names are configurable (a gateway may spell `x-team-id` as `X-Team`).
- **Optional session header**: `x-deepseek-harness-session-id` is sent by default and can be switched off on the card.
- **Optional budget gate**: off by default. When on, a session whose first request is estimated above the ceiling is detached and that decision is pinned.
- **Only the memory chain is touched**: only routes whose `baseURL` points at 8096 (or a host naming `tdai` / `memory`) are handled. Every other route stays byte-identical — no header added, changed or removed.
- **Auditable on disk**: one JSONL line per decision, so you can check afterwards why a session had memory or not.

## Installation

Plugin-to-DSH compatibility:

| Plugin version | DSH version | Cordis | Schemastery |
| --- | --- | --- | --- |
| 0.1.0 | 0.2.2-rc.1 | 4.1.0 | ≥ 3.18.2 (verified on 3.18.5 and 3.19.0) |

The package ships its own `cordis.patch.yml`: the profile composer mounts the host half automatically and serves `lib/client.js` to the Web client as `/plugins/dsh-memory-gate/client.js` — no extra composition edits are needed after installing.

### Into the `desktop` profile (what this repo actually does)

The `desktop` profile belongs to the Electron app, and `dsh plugin --profile desktop add …` is refused
(`profile "desktop" is managed exclusively by the Electron application`). The package is registered in the
profile's own dependency table instead, and installed with **the app's bundled pnpm**:

```sh
node scripts/install-profile.mjs            # defaults to the desktop profile
node scripts/install-profile.mjs --dry-run  # show the plan, write nothing
```

The script backs up `package.json` / `pnpm-lock.yaml`, records the dependency as
`file:dsh-memory-gate-<version>.tgz`, appends the package name to `dsh.profile.bundles`, installs with the app's
own pnpm, and then **byte-compares** the installed `lib/index.js` against the local build, refusing any result
that carries a nested `node_modules`. Restart the desktop app afterwards.

Three hard rules, enforced by the script and required when installing by hand:

- **Use the app's bundled pnpm** (`%LOCALAPPDATA%\…\dsh-primary-runtime\dependencies\pnpm`, 11.28.5 here).
  A global pnpm 9 ignores `nodeLinker: hoisted` from the profile's `pnpm-workspace.yaml` and relinks
  `node_modules` into an isolated layout — the profile drops from 85 visible packages to 11, which is damage.
- **Never use a `link:` dependency.** `link:` makes the plugin resolve dependencies from its own
  `node_modules`, handing it the dev tree's `@deepseek-ai/schemastery` (3.19.0) while every other bundle in the
  same profile gets the profile root's copy (3.18.5). A `file:` tarball is hoisted by pnpm and resolves exactly
  like the rest.
- **Force a reinstall after replacing the tarball.** A lockfile records the `integrity` of a `file:` dependency, so
  swapping the `.tgz` without changing the specifier makes pnpm print `Already up to date` and reuse the previous
  extraction verbatim. `install-profile.mjs` therefore rebuilds and repacks every time, removes the installed
  directory, and deletes both lockfile records for the package (importer and packages section) so pnpm re-hashes
  and re-extracts instead of trusting the stale entry.

### Other sources

```sh
# GitHub (git source; npm runs `prepare` and builds, Node ^22.19.0 or >=24)
dsh plugin --profile <profile> add github:<owner>/dsh-memory-gate

# tarball
npm ci --legacy-peer-deps=false && npm run build && npm pack
dsh plugin --profile <profile> add ./dsh-memory-gate-<version>.tgz
```

Both apply to profiles other than `desktop`. After installing, restart and check the app's **Plugins** page for an
active `memory-gate` row. Note that the global `dsh` CLI (0.2.1-rc.2 here) is not the kernel the desktop app runs
(0.2.2-rc.1), and `--dump-config` is not available for `desktop`, so the Plugins page is the source of truth.

## Configuration

Open the **Plugins** page → the **dsh-memory-gate** detail page → the **Memory gate** card (on DSH 0.1.5 the card lives under **Settings → Plugins → Plugin configuration**, keyed by the `memory-gate` namespace). The card edits one section with five fields:

| Field | Meaning | Default |
| --- | --- | --- |
| `identities` | Named identities: `id`, `team`, `agent`, `task` plus extra header rows | empty |
| `defaultIdentity` | The identity every model inherits unless it names another one | empty (everything detaches) |
| `headerNames` | The three header names: `team` / `agent` / `task` | `x-team-id` / `x-agent-id` / `x-task-id` |
| `budget` | `enabled` plus `maxRequestTokens` (client-side coarse gate) | off / 120000 |
| `sessionHeader` | Whether to send `x-deepseek-harness-session-id` | on |

The host half validates on save; invalid data (empty id, duplicate id, empty team, header name or value Fetch cannot represent) is refused and echoed back, and nothing is written.

### Usage

1. **Create an identity**: click **Add identity**, give it an id (e.g. `worker`) and the team id for `x-team-id` (**required**: a teamless request is treated as unidentified and can never receive memory injection), plus agent / task and any extra headers you need.
2. **Set the default identity**: pick one under **Default identity**; with none selected, every model without its own pick runs detached.
3. **Pick per model**: open **Settings → Models**, expand a provider card, and find the **Memory identity** dropdown inside the model row's **Model options** disclosure (**Capacities** on 0.1.5):
   - `Default (follow the default identity)` inherits the default identity;
   - `Detach (no identity header)` sends no identity header for that model;
   - an identity id names it directly.

   The dropdown is disabled on unsaved provider rows; save the provider first.

### Effective timing

- **Pinned per session**: a session's first memory-chain request decides whether it has memory from then on. **Later configuration changes only affect new sessions.**
- On a pinned attach, header names, extra rows and the session-header switch still resolve from the current configuration (the identity id is reused; the names are current).
- Non-memory-chain routes are never touched, so configuration has no side effect on them.

## Storage and verification

Data lives under `~/.dsh/storage/memory-gate/` (`~` comes from `$DSH_HOME`, else `$USERPROFILE`/`$HOME` plus `/.dsh`). There are exactly two files, both diagnostics/state owned by this plugin:

| File | Content | Policy |
| --- | --- | --- |
| `sessions.json` | `sessionId → { identity \| null, reason, at, provider, model }` | loaded synchronously; the first write of a run lands immediately; later writes debounce 1 s; bounded at 2000 entries (oldest `at` dropped) |
| `decisions.jsonl` | one JSON line per memory-chain request (`ts/kind/reason/provider/model/session/identity/tokens/chain`) | append-only; rotated to `.1` past 2 MB |

### Verification recipe

1. **Inspect decisions**: send one request over the memory chain, then:

   ```sh
   tail -n 5 ~/.dsh/storage/memory-gate/decisions.jsonl
   # Windows PowerShell:
   Get-Content "$env:USERPROFILE\.dsh\storage\memory-gate\decisions.jsonl" -Tail 5
   ```

   You should see a line like `{"kind":"attach","reason":"attached",...,"identity":"worker",...}`. Non-memory-chain routes produce no line at all.

2. **Inspect pins**:

   ```sh
   cat ~/.dsh/storage/memory-gate/sessions.json
   # Windows PowerShell:
   Get-Content "$env:USERPROFILE\.dsh\storage\memory-gate\sessions.json"
   ```

   The `sessionId` should map to `{ "identity": "worker", "reason": "attached", ... }` (or `"identity": null` when detached).

3. **Prove pinning works**: flip one model to **Detach** in the dropdown, then
   - for a **new session**, `decisions.jsonl` shows `detach reason=model-detached` and `sessions.json` gains that session with `identity: null`;
   - for the **old session**, later requests with the same `sessionId` still show `attach identity="worker"` (the pin wins; configuration is not retroactive).

4. **Prove other routes are untouched**: run a request to a direct provider (e.g. `stepfun`); `decisions.jsonl` gains no line (a `skip` decision is not persisted — it carries no information).

## Storage format

The user layer under the `memory-gate` name (in the profile's cordis patch under this plugin row's `config` on DSH 0.1.7+; in the user settings document's same-named namespace on DSH 0.1.5):

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

The per-model pick (under `llm-pi-ai`; written by the dropdown, no hand-editing needed):

```yaml
llm-pi-ai:
  providers:
    magpie:
      models:
        - id: my-model
          memoryGate: worker   # or "off" (detach) / "default" (follow the default identity)
```

A deployment may also seed composition-base values through the plugin's cordis row `config:` block:

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

> Composition-base values do **not** pass the write-time validator (`apply()` reads the cordis row directly). An extra header row whose name Fetch cannot represent is dropped alone at stamp time with a `console.warn`; every other header — the identity triple and the session header included — is still sent.

## Scope and known limitations

- Only the **pi-ai adapter** (`llm-pi-ai` provider routes, including hand-declared custom providers) is affected. Direct routes such as `dsh-llm-deepseek` never pass through `llm-pi-ai/request-headers` — which is correct: that route has no memory.
- `llm-pi-ai/request-headers` is a **synchronous** waterfall: listeners must run synchronously and call `next()`. This plugin does one map lookup and a handful of `Headers.set` calls on that path, and fails open on any error (failing to add headers must never mean failing to send the request).
- **`bypassed` is terminal — the plugin's largest risk surface.** Once a session detaches on its first request, it will never gain memory again, no matter how the configuration changes. Deleting that session's row from `sessions.json` does **not** make the proxy revoke the bypass; it only makes the plugin decide again (the proxy has already made up its mind). To restore memory, start a new session.
- Only **main requests** pin a session decision: auxiliary calls with a `purpose` (title generation, compaction, …) still carry identity headers but **never** create a pin — an auxiliary call should not decide the main session's fate.
- The budget gate is a **coarse estimate**, not a tokenizer: one token per four non-CJK characters, 0.75 per CJK character, plus 8 tokens of fixed overhead per message. It only answers "is this conversation already large".
- The session header makes the proxy treat a DSH session as one conversation, but it changes neither DSH's own session boundaries nor the proxy's L0/L1/L2/L3 tiers and injector configuration — those stay in the server's YAML.
- 8420 / 8125 are unused; the plugin adds no tunnel, forwards no traffic, and stores no memory content.
- **Whether this plugin works can only be judged from its two own files**: does `decisions.jsonl` show `attach`, and is the session's `identity` non-empty in `sessions.json`. The proxy-side views — `conversation/count`, `layer_counts`, panel data — live on the data plane (8420/8125), and a common local setup forwards **only 8096** (`ssh -L …:8096:…`). In that case `curl 127.0.0.1:8096/v3/…` answers `model must be a nonempty string`: 8096 is a chat route and `/v3` is simply not on that tunnel. Do not read that as "memory is not connected".
- The dropdown is injected into the official Models page's per-row **Model options** disclosure (called **Capacities** on 0.1.5) through DOM anchors, because the official slot contract offers no per-model-row extension point. If the page structure changes, the plugin simply stops injecting and leaves the page untouched; a collapsed model row renders no such container, so the dropdown appears when the row expands.

## Development

```sh
npm ci --legacy-peer-deps=false  # install strictly from the lockfile and enforce host peers
npm run typecheck   # typecheck
npm test            # vitest: pure logic / decision matrix / storage / host seams
npm run test:scripts # CI matrix, failure summaries and release-gate tests
npm run build       # emit lib/index.js (host), lib/client.js (web), type declarations
npm run pack:check  # pack and strictly consume the artifact and public types with the exact cohort
node scripts/smoke.mjs        # walk the decision matrix's nine branches by hand (after a build)
npm run install:profile       # install into the desktop profile (see "Install")
```

Two things only bite on Windows: `scripts/*.mjs` need `shell: true` for `npm` / `tar` (they are `.cmd` shims)
but must *not* use a shell for `node -e …` (`cmd.exe` re-parses the quotes and parentheses in those snippets);
and `tar -tf` emits CRLF, so normalise before comparing lines. Also, `esbuild` in this repo's `node_modules`
must be the win32-x64 binary — after installing dependencies inside WSL, reinstall on Windows or
`npm run build` fails with "You installed esbuild for another platform".

`scripts/smoke.mjs` points `$DSH_HOME` at a temp directory before importing the bundle, so it never touches your
real `~/.dsh/storage/memory-gate/`. Do the same in any manual check: otherwise synthetic session ids get pinned
into the real `sessions.json`.

All tests live in `tests/`:

| File | Coverage |
|---|---|
| `tests/identities.spec.ts` | Section defaults and coercion, every validation code (case-insensitive duplicate ids, empty team, invalid header name/value), `identityHeaders` assembly, `estimateTokens` (CJK vs latin), `isMemoryChain`, `parsePick` |
| `tests/gate.spec.ts` | Decision matrix: non-chain skip, model detach, no default identity, missing identity, attach (with session header), pin precedence, deleted pinned identity, budget exceeded, pinned detach stays detached, no session id means no pin, auxiliary calls never pin |
| `tests/store.spec.ts` | Pin round trip in a temp directory, pruning to the bound, corrupt file degrades to an empty store, first write lands immediately, later writes debounce, decision log creates/append/rotate, **batched appends land in call order**, a directory that vanishes mid-flight is dropped quietly |
| `tests/host.spec.ts` | `apply()` over a fake cordis context: listener registration, real `Headers` values, non-chain routes untouched, one bad row dropped alone, fail-open, decision log and single announcement, flush on dispose, write-time validation in both cordis call shapes, 0.1.5 namespace registration, and **`Config` resolved by the real schemastery** (empty / full / partial inputs) |

That last group is not filler: `apply()` is only called *after* the loader validates the row, so tests that call
`apply()` directly never touch the schema layer. A `Config` that builds but cannot resolve would ship with an
all-green suite and then break inside the kernel.

It also earned its keep as a tiebreaker: when I briefly believed the schema itself was broken, this group — calling
`resolve` with the correct signature — showed the schema had been fine all along. The actual bug was in my own
probe (`Schema.resolve` takes the value first). Full post-mortem in `DESIGN.md` §7.1.

CI runs only for PRs and `v*` tag pushes. PRs read the exact DSH/Cordis/Schemastery matrix from `package.json` → `dshCompatibility` and run static, unit and package checks on Node 22 then 24; tags independently run release gates, an explicit build, and npm OIDC publishing without repeating tests. CI does not upload artifacts or create GitHub Releases.

## License

[MIT](LICENSE)