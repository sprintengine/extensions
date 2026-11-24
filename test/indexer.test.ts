import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { checkRepository } from '../src/check.ts'
import { indexCommunity, type Limits } from '../src/indexer.ts'
import type { Identities, Status } from '../src/files.ts'
import { releaseEntryForHead, type Catalogue, type OwnerRecords, type ReleaseLock } from '../src/sdk.ts'
import { git, notesFiles, notesManifest, PNG, setup, SKILL } from './fixtures.ts'

const envs: Array<ReturnType<typeof setup>> = []
afterEach(() => {
  for (const env of envs.splice(0)) env.cleanup()
})

function fixture() {
  const env = setup()
  envs.push(env)
  let clock = Date.parse('2026-11-24T00:00:00Z')
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(env.root, file), 'utf8')) as T
  return {
    ...env,
    read,
    community: () => read<Catalogue>('community.json'),
    lock: () => read<ReleaseLock>('release-lock.json'),
    identities: () => read<Identities>('identities.json'),
    status: () => read<Status>('status.json'),
    owners: () => read<OwnerRecords>('owners.json'),
    advance: (ms: number) => {
      clock += ms
    },
    index: (limits: Partial<Limits> = {}) =>
      indexCommunity({
        root: env.root,
        source: env.source,
        git: { allowFileUrls: true },
        now: () => new Date(clock),
        limits,
      }),
    check: (readBase?: (file: string) => Promise<string | null>) =>
      checkRepository({ root: env.root, allowFileUrls: true, git: { allowFileUrls: true }, ...(readBase ? { readBase } : {}) }),
  }
}

/** The files as they are now, to compare the next change against. */
function snapshot(env: ReturnType<typeof fixture>) {
  const files = new Map<string, string>()
  for (const file of ['official.json', 'community.json', 'owners.json', 'release-lock.json', 'kill-list.json', 'identities.json', 'status.json'])
    files.set(file, readFileSync(join(env.root, file), 'utf8'))
  return async (file: string) => files.get(file) ?? null
}

describe('listing a tagged extension', () => {
  test('pins the tag’s commit and the content hash the SDK’s release-entry prints, under the owner’s key', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0', { annotated: true })
    const expected = await releaseEntryForHead(repo.dir)
    assert.ok(expected.entry)
    // A later commit on the branch is not the release.
    env.commit(repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nLater.\n` })

    const result = await env.index()
    assert.equal(result.listed, 1)
    const [entry] = env.community().extensions
    assert.ok(entry)
    assert.equal(entry.id, 'acme.notes')
    assert.deepEqual(entry.source, { url: repo.url, ref: 'v1.0.0' })
    assert.equal(entry.ownerId, repo.info.owner.id)
    assert.equal(entry.description, 'Take notes.')
    assert.deepEqual(entry.categories, ['productivity'])
    const [release] = entry.releases
    assert.ok(release)
    assert.equal(release.commit, expected.entry.commit)
    assert.equal(release.contentHash, expected.entry.contentHash)
    assert.deepEqual({ ...release, updatedAt: undefined }, { ...expected.entry, updatedAt: undefined })
    assert.equal(release.updatedAt, '2026-11-24T00:00:00.000Z')

    assert.deepEqual(env.lock().releases, [
      { id: 'acme.notes', version: '1.0.0', commit: release.commit, contentHash: release.contentHash },
    ])
    assert.deepEqual(env.owners().owners, [{ login: 'acme', id: repo.info.owner.id }])
    assert.deepEqual(env.identities().extensions['acme.notes'], {
      repoId: 100,
      ownerId: repo.info.owner.id,
      repository: 'acme/notes',
      firstSeen: '2026-11-24T00:00:00.000Z',
    })
    assert.equal(env.status().repos['acme/notes']?.state, 'listed')
    assert.deepEqual(await env.check(), [])
  })

  test('a second run with nothing new changes nothing and fetches nothing', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    env.advance(60 * 60 * 1000)
    const again = await env.index()
    assert.deepEqual(again.changed, [])
  })

  test('a new version is listed first, and the earlier one kept', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    env.commit(repo.dir, notesFiles({ version: '1.1.0' }))
    env.tag(repo.dir, 'v1.1.0')
    env.advance(60 * 60 * 1000)
    await env.index()
    assert.deepEqual(
      env.community().extensions[0]?.releases.map((release) => release.version),
      ['1.1.0', '1.0.0'],
    )
    assert.equal(env.community().extensions[0]?.source.ref, 'v1.1.0')
    assert.deepEqual(env.lock().releases.map((entry) => entry.version), ['1.0.0', '1.1.0'])
  })

  test('a moved tag never replaces a listed version', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const before = env.community()
    const lockBefore = env.lock()
    env.commit(repo.dir, { 'skills/notes/SKILL.md': `${SKILL}\nSomething else.\n` })
    env.tag(repo.dir, 'v1.0.0', { force: true })
    await env.index()
    assert.deepEqual(env.community(), before)
    assert.deepEqual(env.lock(), lockBefore)
    const tag = env.status().repos['acme/notes']?.tags?.['v1.0.0']
    assert.equal(tag?.commit, git(repo.dir, 'rev-parse', 'HEAD'))
    assert.equal(tag?.problems?.[0]?.category, 'moved-tag')
  })

  test('a monorepo lists each folder its catalogue.json names', async () => {
    const env = fixture()
    const dir = env.repository('acme', 'studio-extensions', {}, { id: 100 }).dir
    const url = `file://${dir}`
    env.commit(dir, notesFiles(), 'notes')
    env.commit(dir, notesFiles({ id: 'todo', name: 'Todo' }), 'todo')
    env.commit(dir, {
      'catalogue.json': JSON.stringify({
        catalogueVersion: 1,
        name: 'Acme',
        owner: 'acme',
        extensions: ['notes', 'todo'].map((path) => ({
          id: `acme.${path}`,
          source: { url, ref: 'main', path },
          releases: [],
        })),
      }),
    })
    env.tag(dir, 'v1.0.0')
    await env.index()
    const entries = env.community().extensions
    assert.deepEqual(entries.map((entry) => [entry.id, entry.source.path]), [
      ['acme.notes', 'notes'],
      ['acme.todo', 'todo'],
    ])
    const expected = await releaseEntryForHead(join(dir, 'todo'))
    assert.equal(entries[1]?.releases[0]?.contentHash, expected.entry?.contentHash)
    assert.deepEqual(await env.check(), [])
  })

  test('copies the listing images, named by their hash', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', { ...notesFiles({ icon: 'assets/icon.png' }), 'assets/icon.png': PNG }, { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const icon = env.community().extensions[0]?.releases[0]?.images?.icon
    assert.ok(icon)
    assert.match(icon.path, /^images\/acme\.notes\/[0-9a-f]{16}\.png$/)
    assert.ok(existsSync(join(env.root, icon.path)))
    assert.deepEqual(await env.check(), [])
  })
})

describe('what is refused', () => {
  test('a reserved publisher, and a reserved id', async () => {
    const env = fixture()
    for (const [id, owner] of [
      [100, 'sprintengine'],
      [101, 'studio-labs'],
      [102, 'official'],
    ] as const)
      env.tag(env.repository(owner, 'notes', notesFiles(), { id }).dir, 'v1.0.0')
    env.tag(env.repository('acme', 'notes', notesFiles({ id: 'studio-notes' }), { id: 103 }).dir, 'v1.0.0')
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    assert.equal(env.status().repos['studio-labs/notes']?.reasons?.[0]?.category, 'reserved-name')
    assert.equal(env.status().repos['sprintengine/notes']?.reasons?.[0]?.category, 'reserved-name')
    assert.equal(env.status().repos['acme/notes']?.reasons?.[0]?.category, 'reserved-name')
    assert.deepEqual(env.lock().releases, [])
  })

  test('no release tag, a fork, an archived repository', async () => {
    const env = fixture()
    env.repository('acme', 'notes', notesFiles(), { id: 100 })
    const fork = env.repository('bob', 'notes', notesFiles(), { id: 101 })
    fork.info.fork = true
    env.tag(fork.dir, 'v1.0.0')
    const archived = env.repository('carol', 'notes', notesFiles(), { id: 102 })
    archived.info.archived = true
    env.tag(archived.dir, 'v1.0.0')
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    const reasons = Object.fromEntries(
      Object.entries(env.status().repos).map(([name, record]) => [name, record.reasons?.[0]?.category]),
    )
    assert.deepEqual(reasons, { 'acme/notes': 'no-release-tag', 'bob/notes': 'fork', 'carol/notes': 'archived' })
  })

  test('an invalid manifest, a version that is not the tag’s, no licence, bundled binaries', async () => {
    const env = fixture()
    env.tag(env.repository('a1', 'notes', { 'extension.json': '{"manifestVersion": 1}' }, { id: 100 }).dir, 'v1.0.0')
    env.tag(env.repository('a2', 'notes', notesFiles({ version: '2.0.0' }), { id: 101 }).dir, 'v1.0.0')
    const { license: _license, ...unlicensed } = notesManifest()
    env.tag(
      env.repository('a3', 'notes', { 'extension.json': JSON.stringify(unlicensed), 'skills/notes/SKILL.md': SKILL }, { id: 102 }).dir,
      'v1.0.0',
    )
    env.tag(
      env.repository('a4', 'notes', { ...notesFiles(), 'bin/tool': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]) }, { id: 103 }).dir,
      'v1.0.0',
    )
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    const category = (name: string) => env.status().repos[name]?.tags?.['v1.0.0']?.problems?.[0]?.category
    assert.equal(category('a1/notes'), 'manifest')
    assert.equal(category('a2/notes'), 'version')
    assert.equal(category('a3/notes'), 'licence')
    assert.equal(category('a4/notes'), 'binary-files')
    assert.equal(env.status().repos['a4/notes']?.state, 'rejected')
  })

  test('a repository deleted and created again under the same name is refused', async () => {
    const env = fixture()
    const first = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(first.dir, 'v1.0.0')
    await env.index()
    env.repos.delete(100)
    // The same name, a new repository.
    env.repos.set(200, { ...first.info, id: 200 })
    env.commit(first.dir, notesFiles({ version: '1.1.0' }))
    env.tag(first.dir, 'v1.1.0')
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    const record = env.status().repos['acme/notes']
    assert.equal(record?.repoId, 200)
    assert.equal(record?.reasons?.[0]?.category, 'identity')
    assert.equal(env.lock().releases.length, 1)
    assert.equal(env.identities().extensions['acme.notes']?.repoId, 100)
  })

  test('an account name taken again by another account is refused', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    env.repos.delete(100)
    const other = env.repository('acme', 'tasks', notesFiles({ id: 'tasks', name: 'Tasks' }), { id: 300, ownerId: 9999 })
    env.tag(other.dir, 'v1.0.0')
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    assert.equal(env.status().repos['acme/tasks']?.reasons?.[0]?.category, 'identity')
  })

  test('a renamed repository keeps its listing, and waits for a maintainer before a new version', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const listed = env.community()
    repo.info.fullName = 'acme/notebook'
    env.commit(repo.dir, notesFiles({ version: '1.1.0' }))
    env.tag(repo.dir, 'v1.1.0')
    await env.index()
    assert.deepEqual(env.community(), listed)
    assert.equal(env.status().repos['acme/notebook']?.state, 'paused')
    assert.equal(env.status().repos['acme/notebook']?.reasons?.[0]?.category, 'identity-hold')

    // A maintainer confirms the move.
    const identities = env.identities()
    identities.extensions['acme.notes']!.repository = 'acme/notebook'
    writeFileSync(join(env.root, 'identities.json'), `${JSON.stringify(identities, null, 2)}\n`)
    await env.index()
    assert.deepEqual(env.community().extensions[0]?.releases.map((release) => release.version), ['1.1.0', '1.0.0'])
  })

  test('a repository that loses the topic, or is deleted, leaves the listing; its lock and identity stay', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    const gone = env.repository('bob', 'notes', notesFiles(), { id: 101 })
    env.tag(gone.dir, 'v1.0.0')
    await env.index()
    assert.equal(env.community().extensions.length, 2)
    repo.info.topics = []
    env.repos.delete(101)
    await env.index()
    assert.deepEqual(env.community().extensions, [])
    assert.equal(env.status().repos['acme/notes']?.reasons?.[0]?.category, 'unlisted')
    assert.equal(env.status().repos['bob/notes']?.reasons?.[0]?.category, 'gone')
    assert.equal(env.lock().releases.length, 2)
    assert.equal(Object.keys(env.identities().extensions).length, 2)
    assert.equal(env.owners().owners.length, 2)
  })

  test('a lookup that fails keeps the listing as it was', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const listed = env.community()
    repo.info.topics = []
    env.source.byId = async () => {
      throw new Error('GitHub answered HTTP 502')
    }
    await env.index()
    assert.deepEqual(env.community(), listed)
  })

  test('a killed version is not listed', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    env.commit(repo.dir, notesFiles({ version: '1.1.0' }))
    env.tag(repo.dir, 'v1.1.0')
    await env.index()
    writeFileSync(
      join(env.root, 'kill-list.json'),
      JSON.stringify({
        killListVersion: 1,
        generatedAt: '2026-11-25T00:00:00Z',
        extensions: [{ id: 'acme.notes', versions: ['1.1.0'], reason: 'It deletes files.' }],
      }),
    )
    await env.index()
    assert.deepEqual(env.community().extensions[0]?.releases.map((release) => release.version), ['1.0.0'])
    assert.equal(env.lock().releases.length, 2)
  })
})

describe('bounds', () => {
  test('fetches at most `fetchesPerRepo` tags a run, newest first, the rest next run', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    for (const version of ['1.1.0', '1.2.0']) {
      env.commit(repo.dir, notesFiles({ version }))
      env.tag(repo.dir, `v${version}`)
    }
    await env.index({ fetchesPerRepo: 1 })
    assert.deepEqual(env.community().extensions[0]?.releases.map((release) => release.version), ['1.2.0'])
    assert.deepEqual(env.status().repos['acme/notes']?.notes, ['more release tags are read next run'])
    await env.index({ fetchesPerRepo: 1 })
    await env.index({ fetchesPerRepo: 1 })
    assert.deepEqual(env.community().extensions[0]?.releases.map((release) => release.version), ['1.2.0', '1.1.0', '1.0.0'])
  })

  test('a fetch larger than `fetchBytes` lists nothing, and is tried again', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', { ...notesFiles(), 'big.txt': 'x'.repeat(256 * 1024) }, { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index({ fetchBytes: 1024 })
    assert.deepEqual(env.community().extensions, [])
    assert.equal(env.status().repos['acme/notes']?.tags?.['v1.0.0'], undefined)
  })

  test('past the time budget, repositories keep what they had', async () => {
    const env = fixture()
    env.tag(env.repository('acme', 'notes', notesFiles(), { id: 100 }).dir, 'v1.0.0')
    const result = await env.index({ runMs: -1 })
    assert.equal(result.repos, 0)
    assert.deepEqual(env.community().extensions, [])
  })
})

describe('the checks', () => {
  test('refuse a listed version whose commit changed, and a dropped lock entry', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const base = snapshot(env)
    const lock = env.lock()
    lock.releases[0]!.contentHash = 'f'.repeat(64)
    writeFileSync(join(env.root, 'release-lock.json'), JSON.stringify(lock))
    const errors = await env.check(base)
    assert.ok(errors.some((error) => /never moves/.test(error)))
    assert.ok(errors.some((error) => /not at the commit and content hash/.test(error)))
    writeFileSync(join(env.root, 'release-lock.json'), JSON.stringify({ lockVersion: 1, releases: [] }))
    assert.ok((await env.check(base)).some((error) => /only grows/.test(error)))
  })

  test('refuse a reserved name in the community catalogue, and a publisher that is not the owner', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    await env.index()
    const community = env.community()
    community.extensions.push({ ...community.extensions[0]!, id: 'studio.notes' }, { ...community.extensions[0]!, id: 'bob.notes' })
    writeFileSync(join(env.root, 'community.json'), JSON.stringify(community))
    const errors = await env.check()
    assert.ok(errors.some((error) => /studio\.notes is a name only the official catalogue/.test(error)))
    assert.ok(errors.some((error) => /bob\.notes comes from a repository owned by acme/.test(error)))
  })

  test('refuse a kill list that goes back in time, or changes without a newer date', async () => {
    const env = fixture()
    const base = snapshot(env)
    const write = (generatedAt: string, extensions: unknown[] = []) =>
      writeFileSync(join(env.root, 'kill-list.json'), JSON.stringify({ killListVersion: 1, generatedAt, extensions }))
    write('2026-11-01T00:00:00Z')
    assert.ok((await env.check(base)).some((error) => /back in time/.test(error)))
    write('2026-11-24T00:00:00Z', [{ id: 'acme.notes', reason: 'Harmful.' }])
    assert.ok((await env.check(base)).some((error) => /must be newer/.test(error)))
    write('2026-11-24T01:00:00Z', [{ id: 'acme.notes', reason: 'Harmful.' }])
    assert.deepEqual(await env.check(base), [])
  })

  test('with verify, fetch each new release and refuse bytes that are not it', async () => {
    const env = fixture()
    const repo = env.repository('acme', 'notes', notesFiles(), { id: 100 })
    env.tag(repo.dir, 'v1.0.0')
    const base = snapshot(env)
    await env.index()
    assert.deepEqual(await checkRepository({ root: env.root, allowFileUrls: true, verify: true, git: { allowFileUrls: true }, readBase: base }), [])
    const community = env.community()
    community.extensions[0]!.releases[0]!.permissions = ['notifications:show']
    writeFileSync(join(env.root, 'community.json'), JSON.stringify(community))
    const errors = await checkRepository({ root: env.root, allowFileUrls: true, verify: true, git: { allowFileUrls: true }, readBase: base })
    assert.ok(errors.some((error) => /asks for no permissions/.test(error)), errors.join('\n'))
  })
})
