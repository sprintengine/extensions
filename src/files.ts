// The files at this repository's root. Studio reads the first five; the
// indexer keeps the last two as its public record.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Catalogue, KillList, OwnerRecords, ReleaseLock } from './sdk.ts'

export const FILES = {
  official: 'official.json',
  community: 'community.json',
  owners: 'owners.json',
  releaseLock: 'release-lock.json',
  killList: 'kill-list.json',
  identities: 'identities.json',
  status: 'status.json',
} as const

export const CATALOGUE_OWNER = 'sprintengine'
export const COMMUNITY_NAME = 'Community extensions'
export const LISTING_TOPIC = 'sprintengine-extension'

/**
 * Each community extension's place, by GitHub's numeric ids, recorded the
 * first time it was listed. A name can be renamed or registered again; the
 * ids cannot.
 */
export type Identity = {
  repoId: number
  ownerId: number
  /** `<owner>/<repository>` as it was listed; a maintainer updates it to confirm a move. */
  repository: string
  /** The extension's folder in the repository; absent at the root. */
  path?: string
  firstSeen: string
  /** New versions are paused, the listed ones kept, until a maintainer clears this (a rename or a transfer). */
  paused?: string
  /** Taken out of the listing by a maintainer. */
  removed?: string
}
export type Identities = { identitiesVersion: 1; extensions: Record<string, Identity> }

export type TagRecord = {
  commit: string
  /** The extensions this tag listed, as `<key>@<version>`. */
  listed?: string[]
  /** What keeps the tag's extensions out, when that is a property of its commit. */
  problems?: Array<{ category: string; detail: string }>
}
export type RepoStatus = {
  repoId: number
  state: 'listed' | 'paused' | 'rejected' | 'gone'
  extensions: string[]
  reasons?: Array<{ category: string; detail: string }>
  notes?: string[]
  /** The release tags read, and what each gave, so a tag is fetched again only when it moves. */
  tags?: Record<string, TagRecord>
}
export type Status = { statusVersion: 1; repos: Record<string, RepoStatus> }

export type State = {
  official: Catalogue
  community: Catalogue
  owners: OwnerRecords
  releaseLock: ReleaseLock
  killList: KillList
  identities: Identities
  status: Status
}

export const emptyCommunity = (): Catalogue => ({
  catalogueVersion: 1,
  name: COMMUNITY_NAME,
  owner: CATALOGUE_OWNER,
  extensions: [],
})

export async function readJson<T>(root: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(root, file), 'utf8')) as T
}

export const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Write a file only when its text changes; whether it did. */
export async function writeJsonIfChanged(root: string, file: string, value: unknown): Promise<boolean> {
  const next = formatJson(value)
  const before = await readFile(join(root, file), 'utf8').catch(() => null)
  if (before === next) return false
  await writeFile(join(root, file), next)
  return true
}
