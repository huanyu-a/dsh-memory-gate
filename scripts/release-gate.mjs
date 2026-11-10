import { readFile, appendFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { releasePolicy } from './release-policy.mjs'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const policy = releasePolicy(pkg.version, process.env.RELEASE_TAG)
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, { signal: AbortSignal.timeout(20000) })
let latest
if (response.status !== 404) {
  if (!response.ok) throw new Error(`npm registry HTTP ${response.status}; refusing publication`)
  const data = await response.json()
  assert.equal(data.name, pkg.name, 'Unexpected registry package identity')
  assert.ok(data.versions && typeof data.versions === 'object' && !Array.isArray(data.versions), 'Malformed registry versions')
  assert.ok(data['dist-tags'] && typeof data['dist-tags'] === 'object' && !Array.isArray(data['dist-tags']), 'Malformed registry dist-tags')
  if (data.versions?.[pkg.version]) throw new Error(`${pkg.name}@${pkg.version} is already published`)
  latest = data['dist-tags']?.latest
}
releasePolicy(pkg.version, process.env.RELEASE_TAG, latest)
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
await appendFile(process.env.GITHUB_OUTPUT, `dist-tag=${policy.distTag}\nprerelease=${policy.prerelease}\n`)
console.log(`Release gate passed: ${pkg.name}@${pkg.version} → ${policy.distTag}`)
