// One extension's folder at one fetched commit, made into the release a
// catalogue lists. The steps are Studio's install steps, from the SDK: write
// the folder out from the commit's blobs (materializeGitTree), read its
// extension.json, digest its files and fingerprint them. So the `contentHash`
// recorded here is the one Studio computes when it installs that commit, and
// the entry is checked against the bytes with Studio's own mismatch check.
// Nothing here runs the extension's code.

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, sep } from 'node:path'

import {
  EXTENSION_MANIFEST_FILENAME,
  catalogueReleaseEntry,
  catalogueReleaseMismatch,
  computeModuleFileDigestsSync,
  extensionContentFingerprint,
  materializeGitTree,
  parseExtensionManifest,
  studioReadsManifest,
  type CatalogueRelease,
  type ExtensionManifest,
  type GitOptions,
} from './sdk.ts'

export type Problem = { category: string; detail: string }

export type CheckedRelease = {
  manifest: ExtensionManifest
  entry: CatalogueRelease
  /** The folder as Studio would install it; removed by `dispose`. */
  dir: string
  dispose(): Promise<void>
}

/** Files that may hold bytes no person reads: images and fonts. Anything else binary is refused. */
const BINARY_ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf'])
const BINARY_SNIFF_BYTES = 8000

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) out.push(...(await filesUnder(path)))
    else if (item.isFile()) out.push(path)
  }
  return out
}

/** Files that hold binary bytes and are not images or fonts: compiled code a reader cannot check. */
async function binaryFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const path of await filesUnder(dir)) {
    if (BINARY_ALLOWED.has(extname(path).toLowerCase())) continue
    const size = (await stat(path)).size
    if (size === 0) continue
    const head = (await readFile(path)).subarray(0, BINARY_SNIFF_BYTES)
    if (head.includes(0)) found.push(relative(dir, path).split(sep).join('/'))
  }
  return found.sort()
}

/**
 * The release for `path` (the root when absent) at `commit` of the bare
 * repository `repository`, or the problem that keeps it out. `hasLicenceFile`
 * says whether the repository's root holds a licence file, for an extension
 * whose manifest names none.
 */
export async function checkRelease(input: {
  repository: string
  commit: string
  path?: string
  hasLicenceFile: boolean
  git: GitOptions
}): Promise<{ ok: true; release: CheckedRelease } | { ok: false; problem: Problem }> {
  const staging = await mkdtemp(join(tmpdir(), 'sprintengine-catalogue-release-'))
  const dir = join(staging, 'extension')
  const dispose = () => rm(staging, { recursive: true, force: true })
  const refuse = async (category: string, detail: string) => {
    await dispose()
    return { ok: false as const, problem: { category, detail } }
  }
  try {
    try {
      await materializeGitTree({
        repository: input.repository,
        commit: input.commit,
        destination: dir,
        ...(input.path ? { path: input.path } : {}),
        ...input.git,
      })
    } catch (error) {
      return refuse('not-installable', (error as Error).message)
    }
    let source: string
    try {
      source = await readFile(join(dir, EXTENSION_MANIFEST_FILENAME), 'utf8')
    } catch {
      return refuse('no-manifest', `no ${EXTENSION_MANIFEST_FILENAME} ${input.path ? `in ${input.path} ` : ''}at the release`)
    }
    const parsed = parseExtensionManifest(source)
    if (!parsed.ok)
      return refuse(
        'manifest',
        parsed.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')
          .slice(0, 500),
      )
    const manifest = parsed.manifest
    const readable = studioReadsManifest(manifest)
    if (!readable.ok) return refuse('needs-newer-studio', readable.message)
    const digests = computeModuleFileDigestsSync(dir)
    if (!digests.ok)
      return refuse(
        'not-installable',
        digests.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')
          .replaceAll(`${dir}${sep}`, '')
          .slice(0, 500),
      )
    const binaries = await binaryFiles(dir)
    if (binaries.length > 0)
      return refuse('binary-files', `bundles binary files (${binaries.slice(0, 5).join(', ')})`)
    const hasOwnLicence = (await readdir(dir)).some((name) => /^(licen[cs]e|copying)(\..*)?$/i.test(name))
    if (!manifest.license && !hasOwnLicence && !input.hasLicenceFile)
      return refuse('licence', `no licence: add an SPDX "license" to ${EXTENSION_MANIFEST_FILENAME} or a LICENSE file`)
    const contentHash = extensionContentFingerprint(digests.files)
    const entry = catalogueReleaseEntry(manifest, { commit: input.commit, contentHash })
    const mismatch = catalogueReleaseMismatch({ release: entry, manifest, commit: input.commit, contentHash })
    if (mismatch) return refuse('mismatch', mismatch)
    return { ok: true, release: { manifest, entry, dir, dispose } }
  } catch (error) {
    return refuse('error', (error as Error).message)
  }
}
