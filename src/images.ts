// A release's listing images, copied from its folder into this repository so
// Studio can show them before anything is installed. Studio shows PNG, JPEG
// and WebP and checks each file's SHA-256; this keeps to those, checks each
// file is the kind its name says, and holds each to a size.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import type { CatalogueImage, CatalogueRelease, ExtensionManifest } from './sdk.ts'

export const IMAGE_LIMITS = { icon: 256 * 1024, cover: 1024 * 1024, screenshot: 1536 * 1024 } as const
export const SCREENSHOT_LIMIT = 6
export const IMAGES_FOLDER = 'images'

const KINDS: Record<string, (bytes: Buffer) => boolean> = {
  '.png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  '.jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  '.webp': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
}

/** Whether these bytes are an image Studio shows, of the kind the path's extension names. */
export function isShownImage(path: string, bytes: Buffer): boolean {
  const kind = KINDS[extname(path).toLowerCase()]
  return kind !== undefined && kind(bytes)
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/**
 * Copy the manifest's icon, cover and screenshots from the checked-out folder
 * `dir` into `<root>/images/<key>/`, named by their hash. Answers the
 * release's `images` (absent when there are none) and a note for each image
 * left out.
 */
export async function copyListingImages(input: {
  root: string
  key: string
  dir: string
  manifest: ExtensionManifest
}): Promise<{ images?: NonNullable<CatalogueRelease['images']>; notes: string[] }> {
  const notes: string[] = []
  const { manifest } = input
  const copy = async (path: string | undefined, limit: number, alt: string): Promise<CatalogueImage | undefined> => {
    if (!path) return undefined
    let bytes: Buffer
    try {
      bytes = await readFile(join(input.dir, ...path.split('/')))
    } catch {
      notes.push(`image ${path} is not in the release`)
      return undefined
    }
    if (!isShownImage(path, bytes)) {
      notes.push(`image ${path} is not a PNG, JPEG or WebP file`)
      return undefined
    }
    if (bytes.length > limit) {
      notes.push(`image ${path} is larger than ${limit / 1024} KB`)
      return undefined
    }
    const digest = sha256(bytes)
    const target = `${IMAGES_FOLDER}/${input.key}/${digest.slice(0, 16)}${extname(path).toLowerCase()}`
    await mkdir(dirname(join(input.root, target)), { recursive: true })
    await writeFile(join(input.root, target), bytes)
    return { path: target, sha256: digest, alt: alt.slice(0, 256) }
  }
  const icon = await copy(manifest.icon, IMAGE_LIMITS.icon, `${manifest.name} icon`)
  const cover = await copy(manifest.cover, IMAGE_LIMITS.cover, `${manifest.name} cover`)
  const screenshots: CatalogueImage[] = []
  for (const [index, path] of (manifest.screenshots ?? []).slice(0, SCREENSHOT_LIMIT).entries()) {
    const shot = await copy(path, IMAGE_LIMITS.screenshot, `${manifest.name} screenshot ${index + 1}`)
    if (shot) screenshots.push(shot)
  }
  const images = {
    ...(icon ? { icon } : {}),
    ...(cover ? { cover } : {}),
    ...(screenshots.length > 0 ? { screenshots } : {}),
  }
  return { ...(Object.keys(images).length > 0 ? { images } : {}), notes }
}
