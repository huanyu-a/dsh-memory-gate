// Manual decision-matrix smoke run. Not part of `npm test`: it drives the
// built bundle through a hand-rolled cordis-shaped context so each branch can
// be eyeballed. Run with `node scripts/smoke.mjs` after `npm run build`.
//
// It points $DSH_HOME at a throwaway directory *before* importing the bundle,
// because the store resolves its directory from that variable at apply() time.
// Without this the smoke run's synthetic session ids land in the real
// ~/.dsh/storage/memory-gate/sessions.json and can pin real sessions.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'memory-gate-smoke-'))
process.env['DSH_HOME'] = scratch

const { apply } = await import('../lib/index.js')

const L = {}
const overrides = {}
const ctx = {
  settings: { describe: () => [], configure: () => () => {} },
  on: (n, cb) => { (L[n] ??= []).push(cb); return () => {} },
  effect: (fn) => { fn(); return () => {} },
  get: () => ({
    configuration: () => Object.entries(overrides).map(([id, o]) => ({ entry: { options: { id } }, override: o })),
  }),
  fiber: {},
}
apply(ctx, {})

const hdr = (c) => {
  const h = new Headers()
  return Object.fromEntries(L['llm-pi-ai/request-headers'][0](c, h, () => h).entries())
}
const base = { provider: 'magpie', model: 'auto/DeepSeek-Flash', baseURL: 'http://127.0.0.1:8096/dsh/default' }

/** Install a section + provider document pair. */
const configure = (section, models) => {
  overrides['memory-gate'] = section
  overrides['llm-pi-ai'] = { providers: { magpie: { baseURL: base.baseURL, models } } }
}

const worker = { id: 'worker', team: 'T', agent: 'A', task: '', headers: [{ name: 'x-bill', value: 'w1' }] }

configure({ identities: [worker], defaultIdentity: 'worker' }, [{ id: 'auto/DeepSeek-Flash' }])
console.log('1 attach+extra ', JSON.stringify(hdr({ ...base, sessionId: 's-1' })))
console.log('2 non-chain    ', JSON.stringify(hdr({ provider: 'stepfun', model: 'm', baseURL: 'https://api.stepfun.com/v1', sessionId: 's-9' })))

configure({ identities: [worker], defaultIdentity: 'worker' }, [{ id: 'auto/DeepSeek-Flash', memoryGate: 'off' }])
console.log('3 model detach ', JSON.stringify(hdr({ ...base, sessionId: 's-2' })))
console.log('4 pin wins     ', JSON.stringify(hdr({ ...base, sessionId: 's-1' })))

configure({ identities: [worker], defaultIdentity: 'worker' }, [{ id: 'auto/DeepSeek-Flash' }])
console.log('5 aux attaches ', JSON.stringify(hdr({ ...base, sessionId: 's-3', purpose: 'session-title' })))

configure(
  { identities: [worker], defaultIdentity: 'worker', budget: { enabled: true, maxRequestTokens: 10 } },
  [{ id: 'auto/DeepSeek-Flash' }],
)
L['llm/stream'][0](
  { provider: 'magpie', model: 'auto/DeepSeek-Flash', sessionId: 's-4', messages: [{ role: 'user', content: 'x'.repeat(4000) }] },
  () => (async function* () {})(),
)
console.log('6 budget detach', JSON.stringify(hdr({ ...base, sessionId: 's-4' })))
console.log('7 small session', JSON.stringify(hdr({ ...base, sessionId: 's-5' })))

configure({ identities: [], defaultIdentity: '' }, [{ id: 'auto/DeepSeek-Flash' }])
console.log('8 identity gone', JSON.stringify(hdr({ ...base, sessionId: 's-5' })))
console.log('9 no default   ', JSON.stringify(hdr({ ...base, sessionId: 's-6' })))

// The log appends are queued asynchronously; give them a beat, then drop the
// scratch tree so repeated runs leave nothing behind.
await new Promise(resolve => setTimeout(resolve, 250))
rmSync(scratch, { recursive: true, force: true })