# SprintEngine Studio extensions

The extension catalogue [SprintEngine Studio](https://github.com/sprintengine/sprintengine)
reads. Settings → Extensions → Browse shows what these files list, and Studio
checks every install against them. Studio reads them from
`https://raw.githubusercontent.com/sprintengine/extensions/main`.

| File | What it is |
| --- | --- |
| `official.json` | The official catalogue. Only it may list the reserved names. Edited by pull request. |
| `community.json` | The community catalogue. Generated hourly from repositories with the `sprintengine-extension` topic; don't edit it by hand. |
| `release-lock.json` | Every version ever listed, with the commit and content hash it was first listed at. It only grows. |
| `owners.json` | Every listed owner's account name now and numeric id, so Studio notices a rename. |
| `kill-list.json` | Extensions, or versions of them, that Studio switches off and will not install. |
| `identities.json` | Each community extension's repository and owner by GitHub's numeric ids, from its first listing. |
| `status.json` | What the indexer made of each repository with the topic, and why anything was not listed. |
| `images/` | Listing images, named by their hash. Studio shows them before anything is installed. |
| `catalogue.schema.json` | The catalogue's JSON Schema, a copy of the SDK's. |
| `site/` | The page install links point at (GitHub Pages). |

The formats are in the SDK's
[catalogue guide](https://github.com/sprintengine/sprintengine/blob/main/packages/extension-sdk/guide/catalogue.md).
Listings follow the [listing policy](LISTING_POLICY.md).

## Getting an extension listed

Community extensions live in their authors' own public GitHub repositories.

1. Commit the extension's folder (`extension.json` and every file it ships) at
   the repository's root. Give it a licence: an SPDX `license` in
   `extension.json`, or a `LICENSE` file.
2. Commit the `version` in `extension.json`, tag that commit `v<version>` and
   push the tag: `git tag -a v1.2.0 -m v1.2.0 && git push origin v1.2.0`.
3. Add the topic: `gh repo edit <owner>/<repo> --add-topic sprintengine-extension`.

Within the hour the indexer lists it in `community.json` as `<owner>.<id>`,
the owner lowercased, and records the result for your repository in
`status.json`. Each new `v<x.y.z>` tag is a new release; earlier ones stay
listed. Studio installs a community release on its own only once it has
been listed for 12 hours.

One repository can hold several extensions, each in a folder: put a
`catalogue.json` at its root whose entries name this repository and each
folder in `source.path`. Every folder is read at each release tag, and lists
the version its own `extension.json` says.

A listed version never changes. Moving a tag to another commit does not
replace what was listed: publish a new version instead.

### What the indexer checks

Each extension is checked out at the tag's commit exactly as Studio installs
it, with the SDK's own code, and its content hash is the one Studio computes.
It is not listed when:

- the repository is a fork, archived, or has no `v<x.y.z>` tag;
- `extension.json` is missing or invalid, needs a newer Studio than the
  indexer knows, or its `version` is not the tag's;
- it has no licence, or bundles binary files other than images and fonts;
- its publisher (`sprintengine`, `official`, `local`, any starting `studio`)
  or its id (starting `studio-` or `sprintengine-`) is reserved for the
  official catalogue;
- the version is already listed at another commit, or is on the kill list.

### Names are pinned to GitHub's ids

The first listing records the repository's and the owner's numeric ids.

- A repository that is renamed or transferred, or whose owner is renamed,
  keeps what is listed, but its new versions wait until a maintainer confirms
  the move by setting `repository` in `identities.json` to the new name.
- A repository deleted and created again under the same name is refused, and
  so is an account name registered again by another account.
- A repository that is deleted, or loses the topic, leaves the listing. Its
  identity and its locked versions stay, so the name and those versions cannot
  be reused for other code.

## Official entries

Official extensions are added by pull request to `official.json`:

1. In the extension's repository, run
   `npx sprintengine-extension release-entry <folder>` on the committed
   release. It prints the release entry (commit, content hash, tier, the
   Studio it needs, permissions and contributions) and the `source.path`.
2. Add the entry, newest release first, keeping earlier releases listed when
   a new one raises `engines.studio`.
3. Run `npm run lock` to add the new releases to `release-lock.json`, and
   `npm run check` to check every file.

The pull request's checks fetch every new release and compare its bytes and
its `extension.json` with the entry, as Studio does at install.

## Kills

A listing that breaks the policy is removed: set `removed` to the reason on
its record in `identities.json` (community) or drop the entry (official). One
that harms people who installed it also goes on the kill list, by pull request
to `kill-list.json`:

```json
{ "id": "acme.notes", "versions": ["1.2.0"], "reason": "It uploads the workspace.", "advisoryUrl": "https://github.com/sprintengine/extensions/security/advisories/..." }
```

Leave out `versions` to kill every version. Every change raises `generatedAt`
to the time it is written: Studio refuses a list older than the one it has,
or dated more than a day ahead. Studio reads the list every few hours and
before every install and update; a killed version is switched off and
everything it added is retracted.

## Install links

An install link opens an extension's page in Studio. It never installs: the
person reads the page and presses Install.

```text
sprintengine://extensions/<publisher>.<id>?catalog=<official | community | git URL>
```

Browsers and README viewers often block custom schemes, so link to the page
in `site/` instead. It shows the listing, opens the link in Studio, and says
how to get Studio when it is missing:

```md
[Open in SprintEngine Studio](https://sprintengine.github.io/extensions/?id=acme.notes&catalog=community)
```

## Development

The indexer and the checks import the SDK built from the app repository at
the commit `sdk.json` pins, so the content hash and every check are Studio's
own. Bump the pin deliberately.

```sh
npm ci
npm run setup                       # build the SDK at the pinned commit into .sdk/
npm test                            # the indexer and the checks, against local git fixtures
npm run check                       # check every file
GITHUB_TOKEN=... npm run index      # index the community catalogue
```

`.github/workflows/index.yml` runs the indexer hourly and on demand, checks
the result and commits only what changed. `.github/workflows/check.yml`
checks every pull request.

## Licence

[MIT](LICENSE)
