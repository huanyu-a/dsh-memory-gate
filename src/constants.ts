/**
 * Plugin-wide constants shared by the host and browser halves.
 *
 * @module dsh-memory-header-gate/constants
 */

/**
 * Stable plugin id: the cordis plugin name, the bundle id, and the client
 * module id (all keyed by package name). The cordis.patch.yml ROW id is
 * `memory-gate` instead — see that file for why the row id carries the
 * settings-namespace continuity.
 */
export const PLUGIN_ID = 'dsh-memory-header-gate'

/**
 * The settings namespace this plugin OWNS: the named memory identities,
 * edited from the plugin's configuration card. On DSH 0.1.5 this is the
 * registered settings namespace; on DSH 0.1.7+ it is the plugin's cordis row
 * id (whose volatile Config field the settings service serves) — identical
 * either way, so data written under one generation reads back under the
 * other.
 */
export const MEMORY_GATE_NS = 'memory-gate'

/** The settings namespace this plugin READS and annotates: pi-ai provider routes. */
export const PI_AI_NS = 'llm-pi-ai'

/**
 * Model-level field written onto a pi-ai model row when the user picks a
 * memory gate for it ("默认"/Default removes the field). Schemastery passes
 * unknown model keys through, so the field survives official Models page
 * saves and restarts; pi-ai's catalog resolution enumerates its own known
 * fields and never forwards this one onto the wire model.
 *
 * Values: `off` (摘下记忆链), `default` (随默认身份), or an identity id.
 */
export const MEMORY_GATE_FIELD = 'memoryGate'

/** Locale dictionary namespace for the browser half's copy (not a settings namespace). */
export const STORE_NS = PLUGIN_ID

/**
 * The request header DSH does NOT send but the TDAI memory proxy reads to key
 * a conversation (`session/session-key.ts` → `resolveConversationId`). Sending
 * it gives every memory-chain request a stable, session-scoped identity, so
 * the proxy reuses one registered session instead of starting a new one on
 * every turn.
 *
 * WHY THIS EXACT NAME. `resolveConversationId()` reads seven candidates in
 * order, first non-empty wins:
 *
 *   1 x-parent-conversation-id   2 x-conversation-id   3 x-session-id
 *   4 x-claude-code-session-id   5 x-deepseek-harness-session-id
 *   6 x-chat-id                  7 x-thread-id
 *
 * The proxy source comments #5 as "dsh (deepseek-harness) sends this" — but DSH
 * never does, which is why the proxy logs `conversationId=null` and cannot
 * group turns. Filling in #5 is therefore the intended repair. It also stays
 * clear of #3, so if anything else ever sets `x-session-id` this plugin does
 * not fight it for precedence.
 *
 * Do not "fix" this to `x-session-id` on the strength of a request example:
 * the examples use #3 only because any of the seven works. Injection size is
 * identical either way (the proxy injects its L2/L3 profile, not the turn
 * history), so a size comparison cannot tell the two apart — only the
 * resolution chain can.
 */
export const DSH_SESSION_HEADER = 'x-deepseek-harness-session-id'

/** The identity fields that own a configurable header name. */
export const CONFIGURED_HEADER_FIELDS = ['team', 'agent', 'task'] as const

/**
 * Header names a configured identity field must never take.
 *
 * Two reasons, both measured: an attach would overwrite the caller's own
 * credential (`authorization` becomes the team value), and a detach deletes the
 * names this plugin may have set — so configuring `authorization` would delete
 * the caller's Bearer token.
 */
export const RESERVED_TRANSPORT_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'expect',
  'upgrade',
]

/** Default identity header names, matching the proxy's `headerAutoSelect` defaults. */
export const DEFAULT_TEAM_HEADER = 'x-team-id'
export const DEFAULT_AGENT_HEADER = 'x-agent-id'
export const DEFAULT_TASK_HEADER = 'x-task-id'

/** Only explicitly trusted HTTP(S) origins may receive memory identity headers. */
export const DEFAULT_TRUSTED_ORIGINS: readonly string[] = ['http://127.0.0.1:8096']
