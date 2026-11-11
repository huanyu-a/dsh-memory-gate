import YAML from 'yaml'
import { readFileSync } from 'node:fs'

// The package name comes from the manifest: repeating it here would leave this
// pruner silently matching nothing after a rename, and it would then either
// throw "no record found" or, with allowMissing, delete nothing.
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/** Remove only this plugin's stale importer, package and snapshot records. */
export function pruneMemoryGateLock(text, { allowMissing = false } = {}) {
  const document = YAML.parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`invalid profile lockfile: ${document.errors[0].message}`)
  let removed = 0
  const removeMatches = (map, matches) => {
    if (!YAML.isMap(map)) return
    for (const pair of [...map.items]) {
      const key = String(pair.key)
      if (matches(key)) {
        map.delete(key)
        removed++
      }
    }
  }
  const importers = document.get('importers', true)
  if (YAML.isMap(importers)) {
    for (const pair of importers.items) {
      if (!YAML.isMap(pair.value)) continue
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        removeMatches(pair.value.get(field, true), key => key === PACKAGE)
      }
    }
  }
  for (const section of ['packages', 'snapshots']) {
    removeMatches(document.get(section, true), key => key.startsWith(`${PACKAGE}@file:`))
  }
  if (removed === 0 && !allowMissing) throw new Error('no memory-gate lockfile record found; cannot force a re-extract safely')
  return { text: removed === 0 ? text : document.toString(), removed }
}
