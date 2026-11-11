// Measurement, not an assertion: prints the real cost of loading a full pin
// file so the number quoted in DESIGN.md can be re-derived after code changes.
// Run with: npx vitest run tests/store.perf.spec.ts --reporter=verbose
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSessionStore } from '../src/store.js'

/** A maximal-shape pin: snapshot, three extra rows, removal names, marker. */
function maximal(i: number) {
  return {
    identity: 'tdai-main',
    reason: 'attached' as const,
    at: 1_700_000_000_000 + i,
    provider: 'magpie',
    model: 'auto/DeepSeek-Flash',
    snapshot: {
      identity: {
        id: 'tdai-main', team: 'team-xn421vzsi4', agent: 'a'.repeat(40), task: 'task-abcd1234',
        headers: [
          { name: 'x-extra-one', value: 'v'.repeat(24) },
          { name: 'x-extra-two', value: 'w'.repeat(24) },
          { name: 'x-extra-three', value: 'y'.repeat(24) },
        ],
      },
      headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
      sessionHeader: true,
    },
    removeHeaderNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
    migratedAt: 1_700_000_000_000 + i,
  }
}

describe('pin file load cost', () => {
  it('reports size and load time at the 2,000-pin bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-perf-'))
    try {
      const sessions: Record<string, unknown> = {}
      for (let i = 0; i < 2_000; i += 1) sessions[`session-${String(i)}`] = maximal(i)
      const body = JSON.stringify({ version: 1, sessions })
      writeFileSync(join(dir, 'sessions.json'), body)

      const started = process.hrtime.bigint()
      const store = createSessionStore(dir)
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6

      console.log(`pin file: ${(body.length / 1048576).toFixed(2)} MiB, load ${elapsed.toFixed(1)} ms`)
      // The bound is what matters; the exact figure is environment-dependent.
      expect(store.size()).toBe(2_000)
      expect(elapsed).toBeLessThan(1_000)
      expect(body.length).toBeLessThan(3 * 1048576)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
