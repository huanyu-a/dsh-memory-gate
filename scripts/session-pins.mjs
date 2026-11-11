// Maintenance CLI for the session pin file. The plugin pins a session to an
// identity on its first eligible request and never re-decides, so a pin written
// during a misconfiguration (for example `no-default-identity`, which pins
// `identity: null`) outlives the fix: that session stays detached forever.
// Nothing in the plugin calls `SessionStore.delete()`, so the only way back is
// this script.
//
//   node scripts/session-pins.mjs                      # list
//   node scripts/session-pins.mjs --clear <session-id> # re-decide one session
//   node scripts/session-pins.mjs --clear-detached     # every identity:null pin
//   node scripts/session-pins.mjs --clear --yes        # same, without the prompt
//   node scripts/session-pins.mjs --dir=<dir> --force  # a restored copy, app may run
//
// Writes are refused while DSH runs: the plugin holds the pins in memory and
// flushes the whole map, so an external edit would be overwritten.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dshRunning } from './rollback-profile.mjs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

// The storage path comes from the built host bundle, not a local copy: the CLI
// must read exactly the directory the plugin writes, and a duplicated rule
// would drift the moment that path changes.
const { storeDir } = await import('../lib/index.js')

const args = process.argv.slice(2)
const yes = args.includes('--yes')
// Bypass the running-app guard. Only for a scratch directory that the live
// plugin cannot be holding in memory (fixtures, restored copies).
const force = args.includes('--force')
const clearDetached = args.includes('--clear-detached')
const clearFlag = args.indexOf('--clear')
const FLAGS = new Set(['--yes', '--force', '--clear-detached', '--clear'])
// The argument after `--clear` is a session id only when it is not itself a
// flag: `--clear --yes` means "clear nothing, prompt anyway" and must not treat
// the flag as an id.
const clearId = clearFlag === -1 || FLAGS.has(args[clearFlag + 1]) || args[clearFlag + 1] === undefined
  ? undefined
  : args[clearFlag + 1]
const dir = args.find(one => one.startsWith('--dir='))?.slice('--dir='.length) ?? storeDir()
const file = join(dir, 'sessions.json')

const fail = (message) => {
  console.error(`session-pins: ${message}`)
  process.exit(1)
}

if (clearFlag !== -1 && clearId === undefined) {
  // `--clear` was given but nothing usable followed it; listing would quietly
  // hide the mistake.
  fail('--clear needs a session id (or use --clear-detached for every detached pin)')
}

if (!clearDetached && clearId === undefined) {
  // ---- list -------------------------------------------------------------
  if (!existsSync(file)) {
    console.log(`session-pins: no pin file at ${file} (nothing pinned yet)`)
    process.exit(0)
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const sessions = raw?.sessions ?? {}
  const rows = Object.entries(sessions)
  if (rows.length === 0) {
    console.log(`session-pins: ${file} holds no pins`)
    process.exit(0)
  }
  const detached = rows.filter(([, pin]) => pin?.identity === null)
  console.log(`${file}`)
  console.log(`${String(rows.length)} pin(s), ${String(detached.length)} detached, ${String(rows.length - detached.length)} attached`)
  for (const [id, pin] of rows) {
    const identity = pin?.identity === null ? '(detached)' : String(pin?.identity ?? '?')
    const at = typeof pin?.at === 'number' ? new Date(pin.at).toISOString() : '?'
    const frozen = pin?.snapshot === undefined ? '' : ' snapshot'
    console.log(`  ${id}  ${identity}  ${at}${frozen}`)
  }
  if (detached.length > 0) {
    console.log('\nA detached session never re-attaches on its own. To let it decide again:')
    console.log(`  node scripts/session-pins.mjs --clear-detached${yes ? ' --yes' : ''}`)
  }
  process.exit(0)
}

// ---- clear ---------------------------------------------------------------

if (!existsSync(file)) fail(`no pin file at ${file} — nothing to clear`)
if (!force && dshRunning()) {
  fail('DSH is still running — quit it first, or the plugin will rewrite the file from memory (use --force only on a copy)')
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const sessions = raw?.sessions ?? {}
const doomed = clearDetached
  ? Object.entries(sessions).filter(([, pin]) => pin?.identity === null).map(([id]) => id)
  : [clearId]
if (doomed.length === 0 || doomed[0] === undefined) {
  console.log('session-pins: nothing matched — no file written')
  process.exit(0)
}
const present = doomed.filter(id => Object.hasOwn(sessions, id))
if (present.length === 0) {
  console.log(`session-pins: ${doomed.join(', ')} is not pinned — no file written`)
  process.exit(0)
}

if (!yes) {
  console.log(`session-pins: about to drop ${String(present.length)} pin(s) from ${file}:`)
  for (const id of present) {
    const pin = sessions[id]
    console.log(`  ${id}  ${pin?.identity === null ? '(detached)' : String(pin?.identity)}`)
  }
  const ask = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await ask.question('Proceed? [y/N] ')
  ask.close()
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('session-pins: aborted, nothing written')
    process.exit(1)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${file}.bak-pins-${stamp}`
copyFileSync(file, backup)
for (const id of present) delete sessions[id]
const tmp = `${file}.tmp-${String(process.pid)}`
writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2), 'utf8')
renameSync(tmp, file)
console.log(`session-pins: dropped ${String(present.length)} pin(s); backup at ${backup}`)
console.log('session-pins: the next main request from those sessions decides again from the live config')
