// node src/cli.ts index [--file-urls]     index the community catalogue (GITHUB_TOKEN reads the search)
// node src/cli.ts check [--base <ref>] [--verify] [--file-urls]
//                                          check every file, against the files at <ref>
// node src/cli.ts lock                    add every listed release missing from release-lock.json

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { checkRepository } from './check.ts'
import { FILES, readJson, writeJsonIfChanged } from './files.ts'
import { githubSource } from './github.ts'
import { indexCommunity } from './indexer.ts'
import type { Catalogue, ReleaseLock } from './sdk.ts'

const root = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const git = flag('--file-urls') ? { allowFileUrls: true } : {}

async function readAt(ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['show', `${ref}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

async function main(): Promise<number> {
  const command = args[0]
  if (command === 'index') {
    const result = await indexCommunity({
      root,
      source: githubSource(process.env.GITHUB_TOKEN),
      git,
      log: (line) => console.log(line),
    })
    console.log(`indexed ${result.repos} repositories; ${result.listed} extensions listed; changed: ${result.changed.join(', ') || 'nothing'}`)
    return 0
  }
  if (command === 'check') {
    const base = option('--base')
    const errors = await checkRepository({
      root,
      ...(base ? { readBase: (file: string) => readAt(base, file) } : {}),
      allowFileUrls: flag('--file-urls'),
      verify: flag('--verify'),
      git,
    })
    for (const error of errors) console.error(error)
    console.log(errors.length === 0 ? 'Every file checks.' : `${errors.length} problems.`)
    return errors.length === 0 ? 0 : 1
  }
  if (command === 'lock') {
    const lock = await readJson<ReleaseLock>(root, FILES.releaseLock)
    const held = new Set(lock.releases.map((entry) => `${entry.id}@${entry.version}`))
    for (const file of [FILES.official, FILES.community]) {
      const catalogue = await readJson<Catalogue>(root, file)
      for (const entry of catalogue.extensions)
        for (const release of [...entry.releases].reverse()) {
          const key = `${entry.id}@${release.version}`
          if (held.has(key)) continue
          held.add(key)
          lock.releases.push({ id: entry.id, version: release.version, commit: release.commit, contentHash: release.contentHash })
          console.log(`locked ${key}`)
        }
    }
    await writeJsonIfChanged(root, FILES.releaseLock, lock)
    return 0
  }
  console.error('usage: node src/cli.ts index | check [--base <ref>] [--verify] | lock')
  return 2
}

process.exitCode = await main()
