import semver from 'semver'
/** Pure policy: errors stop publication, prereleases can never change latest. */
export function releasePolicy(version, tag, latest) {
  if (!semver.valid(version)) throw new Error(`Invalid package version: ${version}`)
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} must equal v${version}`)
  const prerelease = semver.prerelease(version) !== null
  if (!prerelease && latest !== undefined) {
    if (!semver.valid(latest)) throw new Error('Invalid npm latest version')
    if (!semver.gt(version, latest)) throw new Error(`${version} must be newer than npm latest ${latest}`)
  }
  return { distTag: prerelease ? 'next' : 'latest', prerelease }
}
