// The community indexer. Every public repository tagged with the listing
// topic is read at its release tags (`v<x.y.z>`); each extension found is
// checked as Studio checks it at install (release.ts) and listed in
// community.json under `<owner>.<id>`, its commit and content hash pinned.
//
// What it keeps, so a listing can be trusted later:
// - release-lock.json: every version ever listed with the commit and content
//   hash it was first listed at. First seen wins: a moved tag never replaces
//   a listed version, and the lock only grows.
// - identities.json: each extension's repository and owner by GitHub's
//   numeric ids, from its first listing. A repository renamed or transferred
//   keeps its listing but gets no new version until a maintainer confirms
//   the move (by updating `repository`); one deleted and created again under
//   the same name, or a name taken by another account, is refused.
// - owners.json: every listed owner's account name now and numeric id.
// - status.json: what each repository gave, and why not, for its author.
//
// Bounded: at most `repos` repositories, the newest `tagsPerRepo` tags of
// each and `fetchesPerRepo` fetches of each per run, `fetchBytes` per fetch,
// and a time budget after which the rest keep what they had. Files are
// written only when they change.

import { readdir, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compareVersions, isRepositoryUrl, parseReleaseTags } from './tags.ts'
import { copyListingImages, IMAGES_FOLDER } from './images.ts'
import { checkRelease, type Problem } from './release.ts'
import {
  CATALOGUE_OWNER,
  COMMUNITY_NAME,
  FILES,
  LISTING_TOPIC,
  readJson,
  writeJsonIfChanged,
  type Identities,
  type RepoStatus,
  type Status,
  type TagRecord,
} from './files.ts'
import type { RepoInfo, RepoSource } from './github.ts'
import {
  CATALOGUE_RELEASE_LIMIT,
  fetchGitCommit,
  findKilled,
  isReservedExtensionPublisher,
  isReservedInstallKey,
  publisherFromOwner,
  readKillList,
  runGit,
  type Catalogue,
  type CatalogueEntry,
  type CatalogueRelease,
  type GitOptions,
  type OwnerRecords,
  type ReleaseLock,
} from './sdk.ts'

export type Limits = {
  /** Repositories read per run. */
  repos: number
  /** The newest release tags considered per repository. */
  tagsPerRepo: number
  /** Tags fetched per repository per run; the rest wait for the next run. */
  fetchesPerRepo: number
  /** Extensions read from one repository's catalogue.json. */
  extensionsPerRepo: number
  /** The most one fetch downloads. */
  fetchBytes: number
  /** The time budget of a run. */
  runMs: number
}

export const DEFAULT_LIMITS: Limits = {
  repos: 1000,
  tagsPerRepo: 20,
  fetchesPerRepo: 5,
  extensionsPerRepo: 16,
  fetchBytes: 64 * 1024 * 1024,
  runMs: 40 * 60 * 1000,
}

export type IndexResult = {
  /** The files written, and the image folders changed. */
  changed: string[]
  listed: number
  repos: number
}

type NewRelease = {
  release: CatalogueRelease
  source: CatalogueEntry['source']
  description?: string
  categories: string[]
}

const CATEGORY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LICENCE_RE = /^(licen[cs]e|copying)(\..*)?$/i
const MAX_CATALOGUE_JSON_BYTES = 1024 * 1024

const keyPublisher = (key: string) => key.slice(0, key.indexOf('.'))
const lower = (value: string) => value.toLowerCase()

/** A repository's topics, other than the listing topic, as catalogue categories. */
function categoriesOf(repo: RepoInfo): string[] {
  return repo.topics
    .filter((topic) => topic !== LISTING_TOPIC && topic.length <= 32 && CATEGORY_RE.test(topic))
    .slice(0, 16)
}

export async function indexCommunity(options: {
  root: string
  source: RepoSource
  git?: GitOptions
  now?: () => Date
  limits?: Partial<Limits>
  log?: (line: string) => void
}): Promise<IndexResult> {
  const { root, source } = options
  const git = options.git ?? {}
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const log = options.log ?? (() => undefined)
  const started = (options.now ?? (() => new Date()))()
  const nowIso = started.toISOString()
  const deadline = Date.now() + limits.runMs
  const pastDeadline = () => Date.now() > deadline

  const official = await readJson<Catalogue>(root, FILES.official)
  const previous = await readJson<Catalogue>(root, FILES.community)
  const owners = await readJson<OwnerRecords>(root, FILES.owners)
  const lock = await readJson<ReleaseLock>(root, FILES.releaseLock)
  const identities = await readJson<Identities>(root, FILES.identities)
  const status = await readJson<Status>(root, FILES.status)
  const killRead = readKillList(await readJson<unknown>(root, FILES.killList))
  if (!killRead.ok) throw new Error(`kill-list.json: ${killRead.message}`)
  const killList = killRead.list

  const lockIndex = new Map(lock.releases.map((entry) => [`${entry.id}@${entry.version}`, entry]))
  const previousEntries = new Map(previous.extensions.map((entry) => [entry.id, entry]))
  const newReleases = new Map<string, NewRelease[]>()
  const nextStatus: Record<string, RepoStatus> = { ...status.repos }
  const loginById = new Map(owners.owners.map((owner) => [owner.id, owner.login]))

  // ── Which repositories ───────────────────────────────────────────────────

  const found = new Map<number, RepoInfo>()
  for (const repo of await source.search(LISTING_TOPIC, limits.repos)) found.set(repo.id, repo)
  log(`search: ${found.size} repositories with the topic`)

  // A repository listed before that left the search: gone, untagged, or the search lags.
  for (const [name, record] of Object.entries(status.repos)) {
    if (found.has(record.repoId) || (record.state !== 'listed' && record.state !== 'paused')) continue
    if (pastDeadline()) break
    let repo: RepoInfo | null
    try {
      repo = await source.byId(record.repoId)
    } catch (error) {
      log(`${name}: could not be looked up, kept as it was (${(error as Error).message})`)
      continue
    }
    if (repo && !repo.private && repo.topics.includes(LISTING_TOPIC)) {
      found.set(repo.id, repo)
      continue
    }
    nextStatus[name] = {
      repoId: record.repoId,
      state: 'gone',
      extensions: [],
      reasons: [
        repo
          ? { category: 'unlisted', detail: `the repository no longer has the ${LISTING_TOPIC} topic or is private` }
          : { category: 'gone', detail: 'the repository was deleted' },
      ],
    }
  }

  // ── Each repository ──────────────────────────────────────────────────────

  async function readTag(repo: RepoInfo, publisher: string, tag: string, commit: string): Promise<TagRecord | null> {
    const version = tag.slice(1)
    let fetched: Awaited<ReturnType<typeof fetchGitCommit>>
    try {
      fetched = await fetchGitCommit({ url: repo.cloneUrl, ref: `refs/tags/${tag}`, maxBytes: limits.fetchBytes, ...git })
    } catch (error) {
      log(`${repo.fullName} ${tag}: fetch failed, tried again next run (${(error as Error).message})`)
      return null
    }
    try {
      // The tag moved while this ran: read it next run.
      if (fetched.commit !== commit) return null
      const rootNames = (await runGit(['ls-tree', '--name-only', '-z', commit], { ...git, cwd: fetched.repository }))
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
      const hasLicenceFile = rootNames.some((name) => LICENCE_RE.test(name))
      let folders: Array<string | undefined>
      if (rootNames.includes('extension.json')) folders = [undefined]
      else if (rootNames.includes('catalogue.json')) {
        folders = await catalogueFolders(fetched.repository, commit, repo)
        if (folders.length === 0)
          return {
            commit,
            problems: [{ category: 'no-manifest', detail: 'catalogue.json lists no folder of this repository' }],
          }
      } else
        return {
          commit,
          problems: [{ category: 'no-manifest', detail: 'no extension.json or catalogue.json at the release' }],
        }

      const listed: string[] = []
      const problems: Problem[] = []
      let final = true
      for (const folder of folders) {
        const at = (problem: Problem): Problem =>
          folder ? { category: problem.category, detail: `${folder}: ${problem.detail}` } : problem
        const checked = await checkRelease({
          repository: fetched.repository,
          commit,
          ...(folder ? { path: folder } : {}),
          hasLicenceFile,
          git,
        })
        if (!checked.ok) {
          problems.push(at(checked.problem))
          continue
        }
        const { manifest, entry, dir } = checked.release
        try {
          if (!folder && manifest.version !== version) {
            problems.push({
              category: 'version',
              detail: `extension.json says version ${manifest.version}, and the tag is ${tag}`,
            })
            continue
          }
          const key = `${publisher}.${manifest.id}`
          if (isReservedInstallKey(key)) {
            problems.push(at({ category: 'reserved-name', detail: `id "${manifest.id}" is reserved for Studio’s official catalogue` }))
            continue
          }
          const identity = identities.extensions[key]
          if (identity && identity.repoId !== repo.id) {
            // Another repository holds this id; that may change, so read the tag again later.
            problems.push(at({ category: 'id-taken', detail: `${key} is listed from ${identity.repository}` }))
            final = false
            continue
          }
          if (identity && (identity.path ?? '') !== (folder ?? '')) {
            problems.push(
              at({
                category: 'identity-hold',
                detail: `${key} moved from folder ${identity.path ?? '(the root)'}; a maintainer confirms the move`,
              }),
            )
            final = false
            continue
          }
          if (identity?.removed || identity?.paused) {
            problems.push(at({ category: 'held', detail: identity.removed ?? identity.paused! }))
            final = false
            continue
          }
          const locked = lockIndex.get(`${key}@${manifest.version}`)
          if (locked) {
            if (locked.commit === entry.commit && locked.contentHash === entry.contentHash)
              listed.push(`${key}@${manifest.version}`)
            else
              problems.push(
                at({
                  category: 'moved-tag',
                  detail: `${key} ${manifest.version} is listed at commit ${locked.commit.slice(0, 12)}, and a listed version never changes: publish a new version`,
                }),
              )
            continue
          }
          if (findKilled(killList, key, manifest.version)) {
            problems.push(at({ category: 'killed', detail: `${key} ${manifest.version} is on the kill list` }))
            continue
          }
          identities.extensions[key] ??= {
            repoId: repo.id,
            ownerId: repo.owner.id,
            repository: repo.fullName,
            ...(folder ? { path: folder } : {}),
            firstSeen: nowIso,
          }
          const images = await copyListingImages({ root, key, dir, manifest })
          const release: CatalogueRelease = {
            ...entry,
            updatedAt: nowIso,
            ...(images.images ? { images: images.images } : {}),
          }
          const lockEntry = { id: key, version: manifest.version, commit: entry.commit, contentHash: entry.contentHash }
          lock.releases.push(lockEntry)
          lockIndex.set(`${key}@${manifest.version}`, lockEntry)
          const list = newReleases.get(key) ?? []
          list.push({
            release,
            source: { url: repo.cloneUrl, ref: tag, ...(folder ? { path: folder } : {}) },
            ...(manifest.description ? { description: manifest.description } : {}),
            categories: categoriesOf(repo),
          })
          newReleases.set(key, list)
          listed.push(`${key}@${manifest.version}`)
          log(`${repo.fullName} ${tag}: listed ${key} ${manifest.version}${images.notes.length ? ` (${images.notes.join('; ')})` : ''}`)
        } finally {
          await checked.release.dispose()
        }
      }
      if (!final) return null
      return {
        commit,
        ...(listed.length > 0 ? { listed: listed.sort() } : {}),
        ...(problems.length > 0 ? { problems } : {}),
      }
    } finally {
      await fetched.dispose()
    }
  }

  /** The folders a repository's catalogue.json lists from the repository itself. */
  async function catalogueFolders(repository: string, commit: string, repo: RepoInfo): Promise<string[]> {
    let raw: unknown
    try {
      const listing = (await runGit(['ls-tree', '-l', commit, '--', 'catalogue.json'], { ...git, cwd: repository }))
        .toString('utf8')
      const size = Number(/^\d+ blob [0-9a-f]{40} +(\d+)\t/.exec(listing)?.[1] ?? Infinity)
      if (size > MAX_CATALOGUE_JSON_BYTES) return []
      const bytes = await runGit(['cat-file', 'blob', `${commit}:catalogue.json`], {
        ...git,
        cwd: repository,
        maxBytes: MAX_CATALOGUE_JSON_BYTES + 1024,
      })
      raw = JSON.parse(bytes.toString('utf8'))
    } catch {
      return []
    }
    // Only each entry's source is read: the folders this repository holds. Each is checked as a release.
    const items = (raw as { extensions?: unknown } | null)?.extensions
    if (!Array.isArray(items)) return []
    const folders = items.flatMap((item) => {
      const source = (item as { source?: { url?: unknown; path?: unknown } } | null)?.source
      return typeof source?.url === 'string' &&
        typeof source.path === 'string' &&
        source.path.length > 0 &&
        isRepositoryUrl(source.url, repo.cloneUrl)
        ? [source.path]
        : []
    })
    return [...new Set(folders)].sort().slice(0, limits.extensionsPerRepo)
  }

  async function readRepo(repo: RepoInfo): Promise<RepoStatus> {
    const name = lower(repo.fullName)
    const before = status.repos[name]
    const rejected = (category: string, detail: string): RepoStatus => ({
      repoId: repo.id,
      state: 'rejected',
      extensions: [],
      reasons: [{ category, detail }],
    })
    const publisher = publisherFromOwner(repo.owner.login)
    if (repo.fork) return rejected('fork', 'a fork is not listed: list the repository it was forked from')
    if (repo.archived) return rejected('archived', 'the repository is archived')
    if (!publisher) return rejected('publisher', `the account name ${repo.owner.login} cannot be a publisher`)
    if (isReservedExtensionPublisher(publisher))
      return rejected('reserved-name', `the publisher "${publisher}" is reserved for Studio’s official catalogue`)

    const records = Object.entries(identities.extensions)
    const recreated = records.find(
      ([, identity]) => lower(identity.repository) === name && identity.repoId !== repo.id,
    )
    if (recreated)
      return rejected(
        'identity',
        `${repo.fullName} was deleted and created again (${recreated[0]} was listed from repository ${recreated[1].repoId}), so it is not listed`,
      )
    const reRegistered = records.find(
      ([key, identity]) => keyPublisher(key) === publisher && identity.ownerId !== repo.owner.id,
    )
    if (reRegistered)
      return rejected(
        'identity',
        `the account ${repo.owner.login} is not the account ${reRegistered[0]} was listed under (it was renamed or taken again), so it is not listed`,
      )
    const ownKeys = records.filter(([, identity]) => identity.repoId === repo.id)
    const moved = ownKeys.find(([, identity]) => lower(identity.repository) !== name)
    if (moved)
      return {
        repoId: repo.id,
        state: 'paused',
        extensions: ownKeys.map(([key]) => key).sort(),
        reasons: [
          {
            category: 'identity-hold',
            detail: `moved from ${moved[1].repository} (${moved[0]}) to ${repo.fullName}; new versions wait for a maintainer to confirm the move`,
          },
        ],
        ...(before?.tags ? { tags: before.tags } : {}),
      }

    let lines: string
    try {
      lines = (await runGit(['ls-remote', '--tags', '--', repo.cloneUrl], { ...git, cwd: tmpdir(), maxBytes: 4 * 1024 * 1024 }))
        .toString('utf8')
    } catch (error) {
      log(`${repo.fullName}: tags could not be read, kept as it was (${(error as Error).message})`)
      return before ?? rejected('error', 'its tags could not be read')
    }
    const tags = parseReleaseTags(lines).slice(0, limits.tagsPerRepo)
    if (tags.length === 0) return rejected('no-release-tag', 'no release tag: push a tag such as v1.0.0')

    const notes: string[] = []
    const nextTags: Record<string, TagRecord> = {}
    let fetches = 0
    for (const { tag, commit } of tags) {
      const previousTag = before?.tags?.[tag]
      if (previousTag?.commit === commit) {
        nextTags[tag] = previousTag
        continue
      }
      if (fetches >= limits.fetchesPerRepo || pastDeadline()) {
        if (previousTag) nextTags[tag] = previousTag
        if (!notes.includes('more release tags are read next run')) notes.push('more release tags are read next run')
        continue
      }
      fetches += 1
      const record = await readTag(repo, publisher, tag, commit)
      if (record) nextTags[tag] = record
      else if (previousTag) nextTags[tag] = previousTag
    }
    const newest = nextTags[tags[0]!.tag]
    return {
      repoId: repo.id,
      state: 'listed',
      extensions: [],
      ...(newest?.problems ? { reasons: newest.problems } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      tags: nextTags,
    }
  }

  const repos = [...found.values()].sort((a, b) => a.id - b.id)
  let read = 0
  for (const repo of repos) {
    if (repo.private) continue
    loginById.set(repo.owner.id, repo.owner.login)
    if (pastDeadline()) {
      log(`time budget spent: ${repos.length - read} repositories keep what they had`)
      break
    }
    read += 1
    nextStatus[lower(repo.fullName)] = await readRepo(repo)
  }

  // ── The listing ──────────────────────────────────────────────────────────

  const statusByRepo = new Map<number, [string, RepoStatus]>()
  for (const [name, record] of Object.entries(nextStatus)) {
    const current = statusByRepo.get(record.repoId)
    // A repository listed under two names (renamed): the live record wins.
    if (!current || (current[1].state === 'gone' && record.state !== 'gone')) statusByRepo.set(record.repoId, [name, record])
  }

  const keys = [...new Set([...previousEntries.keys(), ...newReleases.keys()])].sort()
  const extensions: CatalogueEntry[] = []
  for (const key of keys) {
    const identity = identities.extensions[key]
    if (!identity || identity.removed || isReservedInstallKey(key)) continue
    const repoStatus = statusByRepo.get(identity.repoId)
    if (!repoStatus || repoStatus[1].state === 'gone' || repoStatus[1].state === 'rejected') continue
    // A repository now owned by another account lists its extensions under that account.
    if (repoStatus[1].state === 'listed' && keyPublisher(key) !== publisherFromOwner(repoStatus[0].split('/')[0]!))
      continue
    const fresh = newReleases.get(key) ?? []
    const before = previousEntries.get(key)
    const byVersion = new Map<string, CatalogueRelease>()
    for (const release of [...fresh.map((item) => item.release), ...(before?.releases ?? [])])
      if (!byVersion.has(release.version)) byVersion.set(release.version, release)
    const releases = [...byVersion.values()]
      .filter((release) => !findKilled(killList, key, release.version))
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, CATALOGUE_RELEASE_LIMIT)
    if (releases.length === 0) continue
    const newest = [...fresh].sort((a, b) => compareVersions(b.release.version, a.release.version))[0]
    const description = newest ? newest.description : before?.description
    extensions.push({
      id: key,
      source: newest?.source ?? before!.source,
      ownerId: identity.ownerId,
      ...(description ? { description } : {}),
      categories: newest?.categories ?? before?.categories ?? [],
      releases,
    })
    repoStatus[1].extensions = [...new Set([...repoStatus[1].extensions, key])].sort()
  }
  for (const [, record] of statusByRepo.values())
    if (record.state === 'listed' && record.extensions.length === 0) {
      record.state = 'rejected'
      record.reasons ??= [{ category: 'nothing-listed', detail: 'no release tag holds an extension that could be listed' }]
    }

  const community: Catalogue = { catalogueVersion: 1, name: COMMUNITY_NAME, owner: CATALOGUE_OWNER, extensions }

  // Every owner ever listed, by the name it has now, so Studio sees a rename.
  const ownerIds = [...new Set(Object.values(identities.extensions).map((identity) => identity.ownerId))]
  const nextOwners: OwnerRecords = {
    ownersVersion: 1,
    owners: ownerIds
      .map((id) => {
        const fromIdentity = Object.values(identities.extensions).find((identity) => identity.ownerId === id)!
        return { login: loginById.get(id) ?? fromIdentity.repository.split('/')[0]!, id }
      })
      .sort((a, b) => lower(a.login).localeCompare(lower(b.login)) || a.id - b.id),
  }

  const sortedStatus: Status = {
    statusVersion: 1,
    repos: Object.fromEntries(Object.entries(nextStatus).sort(([a], [b]) => a.localeCompare(b))),
  }
  const sortedIdentities: Identities = {
    identitiesVersion: 1,
    extensions: Object.fromEntries(Object.entries(identities.extensions).sort(([a], [b]) => a.localeCompare(b))),
  }

  const changed: string[] = []
  const write = async (file: string, value: unknown) => {
    if (await writeJsonIfChanged(root, file, value)) changed.push(file)
  }
  await write(FILES.community, community)
  await write(FILES.owners, nextOwners)
  await write(FILES.releaseLock, lock)
  await write(FILES.identities, sortedIdentities)
  await write(FILES.status, sortedStatus)
  changed.push(...(await pruneImages(root, [official, community])))
  return { changed, listed: extensions.length, repos: read }
}

/** Remove images no catalogue names any more; the folders they leave empty go too. */
async function pruneImages(root: string, catalogues: Catalogue[]): Promise<string[]> {
  const named = new Set<string>()
  for (const catalogue of catalogues)
    for (const entry of catalogue.extensions)
      for (const release of entry.releases) {
        const images = release.images
        for (const image of [images?.icon, images?.cover, ...(images?.screenshots ?? [])])
          if (image) named.add(image.path)
      }
  const removed: string[] = []
  const folder = join(root, IMAGES_FOLDER)
  let keys: string[]
  try {
    keys = await readdir(folder)
  } catch {
    return removed
  }
  for (const key of keys) {
    const dir = join(folder, key)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const path = `${IMAGES_FOLDER}/${key}/${file}`
      if (named.has(path)) continue
      await rm(join(root, path), { force: true })
      removed.push(path)
    }
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  }
  return removed
}
