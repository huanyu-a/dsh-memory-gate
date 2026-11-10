/**
 * Shared vitest setup, applied to every test file after its environment is
 * established. Kept intentionally small: the host half is Node-only, so no
 * DOM globals are installed here; the client half (once ported) selects jsdom
 * per file with a `@vitest-environment` directive.
 *
 * Node 22/24 already provide `Headers`, which `identities.ts` probes for
 * representable header names and values — no polyfill is needed.
 */
export {}