/**
 * Plugin-wide constants shared by the host and browser halves.
 *
 * @module dsh-memory-gate/constants
 */

/**
 * Stable plugin id: the cordis plugin name, the bundle id, and the client
 * module id (all keyed by package name). The cordis.patch.yml ROW id is
 * `memory-gate` instead — see that file for why the row id carries the
 * settings-namespace continuity.
 */
export const PLUGIN_ID = 'dsh-memory-gate'

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
 */
export const DSH_SESSION_HEADER = 'x-deepseek-harness-session-id'

/** Default identity header names, matching the proxy's `headerAutoSelect` defaults. */
export const DEFAULT_TEAM_HEADER = 'x-team-id'
export const DEFAULT_AGENT_HEADER = 'x-agent-id'
export const DEFAULT_TASK_HEADER = 'x-task-id'

/**
 * How a provider is recognized as sitting behind the TDAI memory proxy.
 * The proxy is normally exposed as `http://127.0.0.1:8096/<agentSource>/<spaceId>`,
 * so the match is on the port-bearing origin of the provider's base URL.
 */
export const MEMORY_CHAIN_URL_PATTERNS: readonly RegExp[] = [
  /:8096(\/|$)/i,
  /\/\/[^/]*tdai[^/]*\//i,
  /\/\/[^/]*memory[^/]*\//i,
]