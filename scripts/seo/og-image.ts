// Builds the default social-sharing image, public/images/og-default.jpg (1200×630, the size Facebook, LinkedIn and
// X/Twitter all crop to), from the hero photo and the logo: run `npx tsx scripts/seo/og-image.ts` after changing
// either. A one-off, so the Worker never renders images (docs/public-site.md "Social images").
import sharp from 'sharp'

const W = 1200
const H = 630
const BAR = 128
const LOGO_H = 400
const file = (name: string) => new URL(`../../public/images/${name}`, import.meta.url).pathname

const hero = await sharp(file('hero-1500.webp'))
  .resize(W, H - BAR, { fit: 'cover', position: 'centre' })
  .toBuffer()
const logo = await sharp(file('logo-400.webp')).resize({ height: LOGO_H }).toBuffer()

const bar = Buffer.from(`<svg width="${W}" height="${BAR}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${BAR}" fill="#104293"/>
  <rect width="${W}" height="8" fill="#FFA800"/>
  <text x="60" y="84" font-family="Noto Sans" font-weight="700" font-size="46" fill="#ffffff">Tempe Volleyball</text>
  <text x="${W - 60}" y="82" text-anchor="end" font-family="Noto Sans" font-size="30" fill="#ffffff">Social leagues and training in Sydney</text>
</svg>`)

await sharp({ create: { width: W, height: H, channels: 3, background: '#104293' } })
  .composite([
    { input: hero, top: 0, left: 0 },
    { input: logo, top: Math.round((H - BAR - LOGO_H) / 2), left: 60 },
    { input: bar, top: H - BAR, left: 0 },
  ])
  .jpeg({ quality: 82, mozjpeg: true })
  .toFile(file('og-default.jpg'))

console.info('wrote public/images/og-default.jpg')
