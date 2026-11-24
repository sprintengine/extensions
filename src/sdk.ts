// The extension SDK, built from the app repository at the commit sdk.json pins
// (scripts/setup-sdk.sh). Everything that decides what a release is, and what
// its content hash is, comes from here: the same code Studio runs at install.

export {
  CATALOGUE_RELEASE_LIMIT,
  KILL_LIST_FIELDS,
  KILL_LIST_FUTURE_SKEW_MS,
  OWNER_RECORDS_FIELDS,
  RELEASE_LOCK_FIELDS,
  catalogueReleaseEntry,
  catalogueReleaseMismatch,
  findKilled,
  gitUrlPublisher,
  isReservedInstallKey,
  isSameGitRepository,
  publisherFromOwner,
  readCatalogue,
  readKillList,
  validateCatalogue,
} from '../.sdk/dist/catalogue.js'
export type {
  Catalogue,
  CatalogueEntry,
  CatalogueImage,
  CatalogueRelease,
  KillList,
  OwnerRecords,
  ReleaseLock,
  ReleaseLockEntry,
} from '../.sdk/dist/catalogue.js'
export { fetchGitCommit, materializeGitTree, runGit } from '../.sdk/dist/git-source.js'
export type { GitOptions } from '../.sdk/dist/git-source.js'
export {
  EXTENSION_MANIFEST_FILENAME,
  isReservedExtensionId,
  isReservedExtensionPublisher,
  parseExtensionManifest,
  studioReadsManifest,
} from '../.sdk/dist/extension-manifest.js'
export type { ExtensionManifest } from '../.sdk/dist/extension-manifest.js'
export { computeModuleFileDigestsSync } from '../.sdk/dist/module-files.js'
export { extensionContentFingerprint } from '../.sdk/dist/signing.js'
export { validateNode } from '../.sdk/dist/manifest-schema.js'
export type { ManifestIssue } from '../.sdk/dist/manifest-schema.js'
export { releaseEntryForHead } from '../.sdk/dist/release-entry.js'
