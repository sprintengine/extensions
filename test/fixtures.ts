// Fixtures: local git repositories in a temporary folder, a copy of this
// repository's files to index into, and a fake GitHub. No network. A
// repository's owner is the folder it sits in (`<tmp>/repos/acme/notes`), as
// Studio reads a `file://` URL's owner.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepoInfo, RepoSource } from '../src/github.ts'
import { LISTING_TOPIC } from '../src/files.ts'

export const SINCE = '0.13.0'
const here = new URL('..', import.meta.url).pathname

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function notesManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'notes',
    version: '1.0.0',
    engines: { studio: `>=${SINCE}` },
    tier: 'declarative',
    name: 'Notes',
    description: 'Take notes.',
    license: 'MIT',
    contributes: {
      skills: [{ id: 'notes', path: 'skills/notes' }],
      commands: [{ id: 'notes.settings', title: 'Notes settings', action: 'app.settings.open' }],
    },
    ...over,
  }
}

export const SKILL = '---\nname: notes\ndescription: Take notes.\n---\nWrite things down.\n'

export type Files = Record<string, string | Buffer>

export const notesFiles = (over: Record<string, unknown> = {}, skill = SKILL): Files => ({
  'extension.json': JSON.stringify(notesManifest(over), null, 2),
  'skills/notes/SKILL.md': skill,
})

/** A 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sprintengine-indexer-test-')))
  const root = join(tmp, 'catalogue')
  mkdirSync(root)
  for (const file of [
    'official.json',
    'community.json',
    'owners.json',
    'release-lock.json',
    'kill-list.json',
    'identities.json',
    'status.json',
    'catalogue.schema.json',
  ])
    cpSync(join(here, file), join(root, file))
  mkdirSync(join(root, '.sdk'))
  cpSync(join(here, '.sdk', 'catalogue.schema.json'), join(root, '.sdk', 'catalogue.schema.json'))

  const repos = new Map<number, RepoInfo>()
  let nextOwner = 1000
  const ownerIds = new Map<string, number>()
  const source: RepoSource & { searchFails?: boolean } = {
    async search() {
      return [...repos.values()].filter((repo) => repo.topics.includes(LISTING_TOPIC) && !repo.private)
    },
    async byId(id) {
      return repos.get(id) ?? null
    },
  }

  /** A repository with these files committed at `path`; its working folder and file:// URL. */
  function repository(owner: string, name: string, files: Files, options: { id: number; path?: string; ownerId?: number }) {
    const dir = join(tmp, 'repos', owner, name)
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '--quiet', '--initial-branch=main')
    git(dir, 'config', 'user.email', 'dev@example.com')
    git(dir, 'config', 'user.name', 'Dev')
    git(dir, 'config', 'tag.gpgSign', 'false')
    git(dir, 'config', 'commit.gpgSign', 'false')
    const ownerId = options.ownerId ?? ownerIds.get(owner) ?? nextOwner++
    ownerIds.set(owner, ownerId)
    const info: RepoInfo = {
      id: options.id,
      fullName: `${owner}/${name}`,
      owner: { login: owner, id: ownerId },
      cloneUrl: `file://${dir}`,
      archived: false,
      fork: false,
      private: false,
      topics: [LISTING_TOPIC, 'productivity'],
    }
    repos.set(options.id, info)
    const folder = options.path ? join(dir, options.path) : dir
    commit(dir, files, options.path)
    return { dir, folder, info, url: info.cloneUrl }
  }

  function commit(dir: string, files: Files, path?: string): string {
    const folder = path ? join(dir, path) : dir
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(folder, file, '..'), { recursive: true })
      writeFileSync(join(folder, file), content)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'change')
    return git(dir, 'rev-parse', 'HEAD')
  }

  function tag(dir: string, name: string, options: { annotated?: boolean; force?: boolean } = {}) {
    git(dir, 'tag', ...(options.force ? ['-f'] : []), ...(options.annotated ? ['-a', '-m', name] : []), name)
  }

  return {
    tmp,
    root,
    repos,
    source,
    repository,
    commit,
    tag,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}
