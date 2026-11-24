// The repositories to index: every public repository with the listing topic,
// from GitHub's search, and one repository by its numeric id (to tell a
// listed repository that left the search from one that is gone).

export type RepoInfo = {
  id: number
  /** `<owner>/<repository>`. */
  fullName: string
  owner: { login: string; id: number }
  cloneUrl: string
  archived: boolean
  fork: boolean
  private: boolean
  topics: string[]
}

export type RepoSource = {
  /** Public repositories with the topic, at most `limit`. */
  search(topic: string, limit: number): Promise<RepoInfo[]>
  /** One repository by id; null when it is gone. Throws when GitHub cannot say. */
  byId(id: number): Promise<RepoInfo | null>
}

type ApiRepo = {
  id: number
  full_name: string
  owner: { login: string; id: number }
  clone_url: string
  archived: boolean
  fork: boolean
  private: boolean
  topics?: string[]
}

const toInfo = (repo: ApiRepo): RepoInfo => ({
  id: repo.id,
  fullName: repo.full_name,
  owner: { login: repo.owner.login, id: repo.owner.id },
  cloneUrl: repo.clone_url,
  archived: repo.archived,
  fork: repo.fork,
  private: repo.private,
  topics: repo.topics ?? [],
})

const REQUEST_TIMEOUT_MS = 30_000

export function githubSource(token: string | undefined, api = 'https://api.github.com'): RepoSource {
  const get = async (path: string): Promise<Response> =>
    fetch(`${api}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sprintengine-extensions-indexer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  return {
    async search(topic, limit) {
      const found = new Map<number, RepoInfo>()
      // The search answers at most 1000 results, 100 a page.
      for (let page = 1; page <= 10 && found.size < limit; page += 1) {
        const query = encodeURIComponent(`topic:${topic} is:public fork:true`)
        const response = await get(`/search/repositories?q=${query}&sort=updated&order=desc&per_page=100&page=${page}`)
        if (!response.ok) throw new Error(`GitHub search answered HTTP ${response.status}`)
        const body = (await response.json()) as { items: ApiRepo[] }
        for (const item of body.items) if (found.size < limit) found.set(item.id, toInfo(item))
        if (body.items.length < 100) break
      }
      return [...found.values()]
    },
    async byId(id) {
      const response = await get(`/repositories/${id}`)
      if (response.status === 404 || response.status === 451) return null
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for repository ${id}`)
      return toInfo((await response.json()) as ApiRepo)
    },
  }
}
