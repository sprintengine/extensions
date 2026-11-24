// The repository's own checks, run on every pull request, after every index
// and before the indexer commits. Every file must be what Studio reads
// strictly (the SDK's validators), and the promises the files make must hold
// against the version before:
//
// - the release lock only grows: no listed version's commit or content hash
//   ever changes, and none is dropped;
// - every release a catalogue lists is in the lock, at the same commit and hash;
// - the community catalogue lists no reserved name (Studio would refuse the
//   whole catalogue), and every entry's publisher is its repository's owner;
// - the kill list reads, is not dated ahead, and never goes back in time;
//   a changed list carries a newer date;
// - each identity keeps its ids; images are there with the hash listed;
// - catalogue.schema.json is the SDK's.
//
// With `verify`, every release new since the base is fetched and its bytes
// checked as Studio checks them at install.

import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FILES, CATALOGUE_OWNER, type Identities } from './files.ts'
import { isShownImage, sha256 } from './images.ts'
import { checkRelease } from './release.ts'
import {
  KILL_LIST_FIELDS,
  KILL_LIST_FUTURE_SKEW_MS,
  OWNER_RECORDS_FIELDS,
  RELEASE_LOCK_FIELDS,
  catalogueReleaseMismatch,
  fetchGitCommit,
  gitUrlPublisher,
  isReservedInstallKey,
  publisherFromOwner,
  readKillList,
  runGit,
  validateCatalogue,
  validateNode,
  type Catalogue,
  type CatalogueRelease,
  type GitOptions,
  type ManifestIssue,
  type ReleaseLock,
} from './sdk.ts'

const IMAGE_MAX_BYTES = 2 * 1024 * 1024

export type CheckOptions = {
  root: string
  /** A file as it was before the change; null when it did not exist. Absent: nothing to compare. */
  readBase?: (file: string) => Promise<string | null>
  /** Accept `file://` source URLs (fixtures and a development Studio only). */
  allowFileUrls?: boolean
  /** Fetch every release new since the base and check its bytes. */
  verify?: boolean
  git?: GitOptions
  now?: () => number
}

/** The publisher a source URL takes, as Studio takes it (a `file://` fixture: the folder its repository is in). */
function sourcePublisher(url: string): string | null {
  const fromUrl = gitUrlPublisher(url)
  if (fromUrl) return fromUrl
  if (!url.startsWith('file://')) return null
  try {
    return publisherFromOwner(basename(dirname(fileURLToPath(url))))
  } catch {
    return null
  }
}

const issuesText = (file: string, issues: ManifestIssue[]) =>
  issues.slice(0, 20).map((issue) => `${file}: ${issue.path || '(root)'} ${issue.message}`)

export async function checkRepository(options: CheckOptions): Promise<string[]> {
  const { root } = options
  const errors: string[] = []
  const now = options.now ?? Date.now
  const text = (file: string) => readFile(join(root, file), 'utf8')
  const json = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await text(file))
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`)
      return undefined
    }
  }
  const base = async (file: string): Promise<unknown> => {
    const raw = options.readBase ? await options.readBase(file) : null
    if (raw === null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  // ── The catalogues ────────────────────────────────────────────────────────

  const catalogues: Array<[string, Catalogue]> = []
  for (const file of [FILES.official, FILES.community]) {
    const raw = await json(file)
    if (raw === undefined) continue
    const result = validateCatalogue(raw)
    const issues = result.ok
      ? []
      : result.issues.filter(
          (issue) =>
            !(
              options.allowFileUrls &&
              issue.path.endsWith('.source.url') &&
              String(
                (raw as Catalogue).extensions[Number(/extensions\[(\d+)\]/.exec(issue.path)?.[1])]?.source.url,
              ).startsWith('file://')
            ),
        )
    if (issues.length > 0) {
      errors.push(...issuesText(file, issues))
      continue
    }
    const catalogue = raw as Catalogue
    catalogues.push([file, catalogue])
    if (catalogue.owner !== CATALOGUE_OWNER) errors.push(`${file}: owner must be ${CATALOGUE_OWNER}`)
    for (const entry of catalogue.extensions) {
      if (file === FILES.community && isReservedInstallKey(entry.id))
        errors.push(`${file}: ${entry.id} is a name only the official catalogue may list`)
      const owner = sourcePublisher(entry.source.url)
      if (owner !== null && owner !== entry.id.slice(0, entry.id.indexOf('.')))
        errors.push(`${file}: ${entry.id} comes from a repository owned by ${owner}`)
      if (file === FILES.community && entry.ownerId === undefined)
        errors.push(`${file}: ${entry.id} has no ownerId`)
    }
  }

  // ── The release lock ──────────────────────────────────────────────────────

  const lockRaw = await json(FILES.releaseLock)
  const lockIssues: ManifestIssue[] = []
  const lock = validateNode(RELEASE_LOCK_FIELDS, lockRaw, '', lockIssues) as ReleaseLock | undefined
  errors.push(...issuesText(FILES.releaseLock, lockIssues))
  const locked = new Map<string, { commit: string; contentHash: string }>()
  for (const entry of lock?.releases ?? []) {
    const key = `${entry.id}@${entry.version}`
    if (locked.has(key)) errors.push(`${FILES.releaseLock}: ${key} is listed twice`)
    locked.set(key, entry)
  }
  const baseLock = (await base(FILES.releaseLock)) as ReleaseLock | undefined
  const baseLocked = new Map<string, { commit: string; contentHash: string }>()
  for (const entry of baseLock?.releases ?? []) {
    const key = `${entry.id}@${entry.version}`
    baseLocked.set(key, entry)
    const now = locked.get(key)
    if (!now) errors.push(`${FILES.releaseLock}: ${key} was removed; the lock only grows`)
    else if (now.commit !== entry.commit || now.contentHash !== entry.contentHash)
      errors.push(`${FILES.releaseLock}: ${key} changed its commit or content hash; a listed version never moves`)
  }

  for (const [file, catalogue] of catalogues)
    for (const entry of catalogue.extensions)
      for (const release of entry.releases) {
        const key = `${entry.id}@${release.version}`
        const pin = locked.get(key)
        if (!pin) errors.push(`${file}: ${key} is not in ${FILES.releaseLock}`)
        else if (pin.commit !== release.commit || pin.contentHash !== release.contentHash)
          errors.push(`${file}: ${key} is not at the commit and content hash ${FILES.releaseLock} holds`)
      }

  // ── Owners, the kill list, identities ─────────────────────────────────────

  const ownersRaw = await json(FILES.owners)
  const ownerIssues: ManifestIssue[] = []
  const owners = validateNode(OWNER_RECORDS_FIELDS, ownersRaw, '', ownerIssues) as
    { owners: Array<{ login: string; id: number }> } | undefined
  errors.push(...issuesText(FILES.owners, ownerIssues))
  const ownerIds = new Set<number>()
  const ownerLogins = new Set<string>()
  for (const owner of owners?.owners ?? []) {
    if (ownerIds.has(owner.id)) errors.push(`${FILES.owners}: owner ${owner.id} is listed twice`)
    if (ownerLogins.has(owner.login.toLowerCase())) errors.push(`${FILES.owners}: ${owner.login} is listed twice`)
    ownerIds.add(owner.id)
    ownerLogins.add(owner.login.toLowerCase())
  }

  const killRaw = await json(FILES.killList)
  const killIssues: ManifestIssue[] = []
  validateNode(KILL_LIST_FIELDS, killRaw, '', killIssues)
  errors.push(...issuesText(FILES.killList, killIssues))
  const kill = readKillList(killRaw)
  if (!kill.ok) errors.push(`${FILES.killList}: ${kill.message}`)
  else {
    if (Date.parse(kill.list.generatedAt) > now() + KILL_LIST_FUTURE_SKEW_MS)
      errors.push(`${FILES.killList}: generatedAt is more than a day ahead; Studio would refuse it`)
    const before = (await base(FILES.killList)) as { generatedAt?: string } | undefined
    if (before && typeof before.generatedAt === 'string') {
      const was = Date.parse(before.generatedAt)
      const is = Date.parse(kill.list.generatedAt)
      if (is < was) errors.push(`${FILES.killList}: generatedAt went back in time; Studio would refuse it`)
      else if (is === was && JSON.stringify(before) !== JSON.stringify(killRaw))
        errors.push(`${FILES.killList}: the list changed, so generatedAt must be newer`)
    }
  }

  const identities = (await json(FILES.identities)) as Identities | undefined
  if (identities && (identities.identitiesVersion !== 1 || typeof identities.extensions !== 'object'))
    errors.push(`${FILES.identities}: is not an identities file`)
  const baseIdentities = (await base(FILES.identities)) as Identities | undefined
  for (const [key, was] of Object.entries(baseIdentities?.extensions ?? {})) {
    const is = identities?.extensions?.[key]
    if (!is) errors.push(`${FILES.identities}: ${key} was removed; identities are kept for good`)
    else if (is.repoId !== was.repoId || is.ownerId !== was.ownerId || is.firstSeen !== was.firstSeen)
      errors.push(`${FILES.identities}: ${key} changed its ids or first-seen time`)
  }
  for (const [file, catalogue] of catalogues)
    if (file === FILES.community)
      for (const entry of catalogue.extensions) {
        const identity = identities?.extensions?.[entry.id]
        if (!identity) errors.push(`${file}: ${entry.id} has no identity in ${FILES.identities}`)
        else if (identity.ownerId !== entry.ownerId)
          errors.push(`${file}: ${entry.id} names another owner id than ${FILES.identities}`)
      }

  const status = (await json(FILES.status)) as { statusVersion?: number; repos?: unknown } | undefined
  if (status && (status.statusVersion !== 1 || typeof status.repos !== 'object'))
    errors.push(`${FILES.status}: is not a status file`)

  // ── Images and the schema ─────────────────────────────────────────────────

  for (const [file, catalogue] of catalogues)
    for (const entry of catalogue.extensions)
      for (const release of entry.releases) {
        const images = release.images
        for (const image of [images?.icon, images?.cover, ...(images?.screenshots ?? [])]) {
          if (!image) continue
          let bytes: Buffer
          try {
            bytes = await readFile(join(root, image.path))
          } catch {
            errors.push(`${file}: ${entry.id} names ${image.path}, which is not in the repository`)
            continue
          }
          if (sha256(bytes) !== image.sha256) errors.push(`${file}: ${image.path} does not match its sha256`)
          if (!isShownImage(image.path, bytes)) errors.push(`${file}: ${image.path} is not a PNG, JPEG or WebP image`)
          if (bytes.length > IMAGE_MAX_BYTES) errors.push(`${file}: ${image.path} is larger than Studio shows`)
          if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(image.path).toLowerCase()))
            errors.push(`${file}: ${image.path} has a name Studio does not show`)
        }
      }

  const schema = await text('catalogue.schema.json').catch(() => null)
  const sdkSchema = await text('.sdk/catalogue.schema.json').catch(() => null)
  if (schema === null) errors.push('catalogue.schema.json is missing')
  else if (sdkSchema !== null && JSON.stringify(JSON.parse(schema)) !== JSON.stringify(JSON.parse(sdkSchema)))
    errors.push('catalogue.schema.json is not the SDK’s copy at the pinned commit: copy .sdk/catalogue.schema.json')

  // ── The bytes of new releases ─────────────────────────────────────────────

  if (options.verify)
    for (const [file, catalogue] of catalogues)
      for (const entry of catalogue.extensions)
        for (const release of entry.releases) {
          if (baseLocked.has(`${entry.id}@${release.version}`)) continue
          const problem = await verifyRelease(entry.source.url, entry.source.path, release, options.git ?? {})
          if (problem) errors.push(`${file}: ${entry.id} ${release.version}: ${problem}`)
        }

  return errors
}

/** Why the bytes at a release's commit are not the release, or null when they are. */
async function verifyRelease(
  url: string,
  path: string | undefined,
  release: CatalogueRelease,
  git: GitOptions,
): Promise<string | null> {
  let fetched: Awaited<ReturnType<typeof fetchGitCommit>>
  try {
    fetched = await fetchGitCommit({ url, ref: release.commit, ...git })
  } catch (error) {
    return `its commit could not be fetched (${(error as Error).message})`
  }
  try {
    const names = (await runGit(['ls-tree', '--name-only', release.commit], { ...git, cwd: fetched.repository }))
      .toString('utf8')
      .split('\n')
    const checked = await checkRelease({
      repository: fetched.repository,
      commit: release.commit,
      ...(path ? { path } : {}),
      hasLicenceFile: names.some((name) => /^(licen[cs]e|copying)(\..*)?$/i.test(name)),
      git,
    })
    if (!checked.ok) return checked.problem.detail
    await checked.release.dispose()
    // What Studio says at install when the bytes are not the release listed.
    return catalogueReleaseMismatch({
      release,
      manifest: checked.release.manifest,
      commit: release.commit,
      contentHash: checked.release.entry.contentHash,
    })
  } finally {
    await fetched.dispose()
  }
}
