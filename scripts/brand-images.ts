// Regenerates the header images in public/images from the originals in scripts/brand/ (docs/public-site.md,
// "Images"): the hero photo and the logo (with the Sydney Uni badge), each in AVIF and WebP at the widths the
// <picture> srcsets name. Run after replacing an original:
//
//   npx tsx scripts/brand-images.ts
//
// sharp comes with Astro, so there's nothing extra to install. The originals are the largest the old site has
// (the hero is 1500 px wide), so nothing is upscaled.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { HERO_WIDTHS, LOGO_WIDTHS } from '../src/lib/brand'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'scripts', 'brand')
const OUT = join(ROOT, 'public', 'images')

await mkdir(OUT, { recursive: true })

async function variants(input: Sharp, name: string, widths: readonly number[]) {
  for (const w of widths) {
    const resized = input.clone().resize({ width: w, withoutEnlargement: true })
    await resized
      .clone()
      .avif({ quality: 50, effort: 6 })
      .toFile(join(OUT, `${name}-${w}.avif`))
    await resized
      .clone()
      .webp({ quality: 72, effort: 6 })
      .toFile(join(OUT, `${name}-${w}.webp`))
    console.info(`${name}-${w}.{avif,webp}`)
  }
}

await variants(sharp(join(SRC, 'hero.jpeg')), 'hero', HERO_WIDTHS)
// The logo's square canvas has a wide transparent margin; trim it so the image is as big as what's drawn.
const logo = sharp(await sharp(join(SRC, 'logo.png')).trim().toBuffer())
const meta = await logo.metadata()
console.info(`logo trimmed to ${meta.width}x${meta.height}`)
await variants(logo, 'logo', LOGO_WIDTHS)
