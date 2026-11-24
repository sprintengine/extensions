// Release tags and versions.

import { isSameGitRepository } from './sdk.ts'

const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Compare two semver versions: by x.y.z, then a pre-release before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = '', pre] = version.split('+')[0]!.split(/-(.*)/s)
    return { parts: core.split('.').map(Number), pre }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * The release tags (`v<x.y.z>`) in `git ls-remote --tags` output, newest
 * version first, each with the commit it points at (an annotated tag peeled).
 */
export function parseReleaseTags(output: string): Array<{ tag: string; commit: string }> {
  const commits = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim())
    if (!match) continue
    const [, commit, tag, peel] = match as unknown as [string, string, string, string | undefined]
    if (!RELEASE_TAG_RE.test(tag)) continue
    ;(peel ? peeled : commits).set(tag, commit)
  }
  return [...commits.keys()]
    .map((tag) => ({ tag, commit: peeled.get(tag) ?? commits.get(tag)! }))
    .sort((a, b) => compareVersions(b.tag.slice(1), a.tag.slice(1)))
}

/** Whether a catalogue entry's URL is this repository's (a `file://` fixture compares as written). */
export function isRepositoryUrl(url: string, cloneUrl: string): boolean {
  return url.trim() === cloneUrl.trim() || isSameGitRepository(url, cloneUrl)
}
