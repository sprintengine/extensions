// The page an install link points at, for places that do not open custom
// schemes (browsers, README viewers):
//   https://sprintengine.github.io/extensions/?id=<publisher>.<id>&catalog=<official | community | git URL>
// It shows what the catalogue lists and opens
//   sprintengine://extensions/<publisher>.<id>?catalog=...
// in Studio. It never installs anything, and Studio checks the link again.

const BASE = 'https://raw.githubusercontent.com/sprintengine/extensions/main'
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_PUBLISHERS = new Set(['sprintengine', 'official', 'local'])

const $ = (id) => document.getElementById(id)

const isReserved = (key) => {
  const [publisher, id] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
  return RESERVED_PUBLISHERS.has(publisher) || publisher.startsWith('studio') || id.startsWith('studio-') || id.startsWith('sprintengine-')
}

/** An HTTPS (no credentials) or SSH git URL of at most 512 characters, as Studio accepts. */
function isGitUrl(value) {
  if (value.length > 512 || /\s/.test(value)) return false
  if (/^[^\s@/:]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return !value.startsWith('-')
  try {
    const url = new URL(value)
    if (url.password || !url.hostname) return false
    return (url.protocol === 'https:' && !url.username) || url.protocol === 'ssh:'
  } catch {
    return false
  }
}

function fail(message) {
  $('title').textContent = 'This link cannot be opened'
  $('error').textContent = message
  $('error').hidden = false
}

function fact(name, value) {
  const dt = document.createElement('dt')
  dt.textContent = name
  const dd = document.createElement('dd')
  dd.textContent = value
  $('facts').append(dt, dd)
  $('facts').hidden = false
}

async function show(key, catalogue) {
  const params = new URLSearchParams(location.search)
  const extra = [...params.keys()].some((name) => name !== 'id' && name !== 'catalog')
  if (location.href.length > 2048 || extra || params.getAll('id').length > 1 || params.getAll('catalog').length > 1)
    return fail('That extension link is not one Studio can open.')
  if (!KEY_RE.test(key) || key.length > 104) return fail('The link does not name an extension as <publisher>.<id>.')
  if (catalogue !== 'official' && catalogue !== 'community' && !isGitUrl(catalogue))
    return fail('The link names a catalogue that is not an HTTPS or SSH git URL.')
  if (catalogue !== 'official' && isReserved(key)) return fail(`${key} is a name only Studio’s official catalogue lists.`)

  const link = `sprintengine://extensions/${key}?catalog=${encodeURIComponent(catalogue)}`
  $('link').href = link
  $('open').hidden = false
  $('title').textContent = key
  $('byline').textContent =
    catalogue === 'official' ? 'Official' : catalogue === 'community' ? `Community · ${key.split('.')[0]}` : catalogue
  if (catalogue !== 'official' && catalogue !== 'community') $('unadded').hidden = false
  // Open it in Studio straight away, as a link click would; the page stays for when Studio is missing.
  location.href = link

  if (catalogue !== 'official' && catalogue !== 'community') return
  let entry
  try {
    const response = await fetch(`${BASE}/${catalogue}.json`, { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const listing = await response.json()
    entry = Array.isArray(listing.extensions) ? listing.extensions.find((item) => item && item.id === key) : undefined
  } catch {
    $('description').textContent = 'The catalogue could not be read just now; Studio reads it again.'
    return
  }
  if (!entry || !Array.isArray(entry.releases) || entry.releases.length === 0) {
    $('description').textContent = `The ${catalogue} catalogue does not list ${key} now.`
    return
  }
  const release = entry.releases[0]
  if (typeof release.name === 'string') $('title').textContent = release.name
  if (typeof entry.description === 'string') $('description').textContent = entry.description
  const icon = release.images && release.images.icon
  if (icon && typeof icon.path === 'string' && /^images\/[A-Za-z0-9._/-]+$/.test(icon.path) && !icon.path.includes('..')) {
    $('icon').src = `${BASE}/${icon.path}`
    $('icon').alt = typeof icon.alt === 'string' ? icon.alt : ''
    $('icon').hidden = false
  }
  fact('Id', key)
  fact('Version', String(release.version))
  fact('Tier', String(release.tier))
  fact('Asks for', Array.isArray(release.permissions) && release.permissions.length > 0 ? release.permissions.join(', ') : 'no permissions')
  if (Array.isArray(release.contributes)) fact('Adds', `${release.contributes.length} contribution${release.contributes.length === 1 ? '' : 's'}`)
  if (typeof release.license === 'string') fact('Licence', release.license)
  if (entry.source && typeof entry.source.url === 'string') fact('Source', entry.source.url)
}

const params = new URLSearchParams(location.search)
const key = params.get('id')
if (key === null) {
  $('title').textContent = 'SprintEngine Studio extensions'
  $('description').textContent =
    'Install links point here: ?id=<publisher>.<id>&catalog=<official | community | git URL>. Browse extensions in Studio, under Settings → Extensions.'
} else show(key, params.get('catalog') ?? 'official')
