import { useState } from 'react'
import { IMAGE_ALIGNS, IMAGE_SIZES, MAX_CAPTION_LENGTH, safeHref, type ImageAlign, type ImageSize } from '../../lib/content/render'
import { MAX_ALT_LENGTH } from '../../lib/content/media'
import { Button, Dialog, Field, Notice, Select, TextArea, confirmAction } from '../ui'

// The image node's settings (double-click an image, or Image settings… in the toolbar): its description (alt text),
// caption, size, alignment and link, plus swapping the file while keeping the rest. render.ts writes them as a
// <figure>; the alt text here is this use of the image (the library's alt is only the default when inserting).

export type ImageAttrs = {
  src: string
  srcset?: string | null
  alt?: string | null
  title?: string | null
  width?: number | string | null
  height?: number | string | null
  caption?: string | null
  align?: ImageAlign | null
  size?: ImageSize | null
  href?: string | null
}

const SIZE_LABEL: Record<ImageSize, string> = {
  small: 'Small (about a third)',
  medium: 'Medium (about half)',
  large: 'Large',
  full: 'Full width',
}
const ALIGN_LABEL: Record<ImageAlign, string> = {
  center: 'Centred',
  left: 'Left, text wraps around it',
  right: 'Right, text wraps around it',
}

export function ImageSettings({
  attrs,
  onSave,
  onCancel,
  onReplace,
}: {
  attrs: ImageAttrs
  onSave: (attrs: Partial<ImageAttrs>) => void
  onCancel: () => void
  onReplace: () => void
}) {
  const [alt, setAlt] = useState(attrs.alt ?? '')
  const [caption, setCaption] = useState(attrs.caption ?? '')
  const [size, setSize] = useState<ImageSize | ''>(attrs.size ?? '')
  const [align, setAlign] = useState<ImageAlign | ''>(attrs.align ?? '')
  const [href, setHref] = useState(attrs.href ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const link = href.trim()
    const normalised = link && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(link) ? `https://${link}` : link
    if (normalised && !safeHref(normalised)) return setError('That link isn’t allowed. Use https://…, a /path, mailto: or tel:.')
    if (
      !alt.trim() &&
      !(await confirmAction({
        title: 'Leave the description empty?',
        body: 'Screen readers and search engines use it. Only leave it empty for a purely decorative image.',
        confirmLabel: 'Leave it empty',
      }))
    )
      return
    onSave({
      alt: alt.trim(),
      caption: caption.trim() || null,
      size: size || null,
      align: align || null,
      href: normalised || null,
    })
  }

  return (
    <Dialog title="Image settings" onCancel={onCancel}>
      {/* The editor sits inside the page's <form>: Enter here applies the settings instead of saving the page. */}
      <div
        className="space-y-4"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
            e.preventDefault()
            void save()
          }
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex items-start gap-3">
          <img src={attrs.src} srcSet={attrs.srcset ?? undefined} sizes="6rem" alt="" className="h-16 w-24 rounded object-cover" />
          <Button variant="secondary" onClick={onReplace}>
            Choose another image…
          </Button>
        </div>
        <TextArea
          label="Description (alt text)"
          rows={2}
          maxLength={MAX_ALT_LENGTH}
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          hint="What the image shows, for people who can't see it. Screen readers read it out."
        />
        <TextArea
          label="Caption"
          rows={2}
          maxLength={MAX_CAPTION_LENGTH}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          hint="Shown under the image. Optional."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Size" value={size} onChange={(e) => setSize(e.target.value as ImageSize | '')}>
            <option value="">As uploaded (up to the page width)</option>
            {IMAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {SIZE_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select label="Alignment" value={align} onChange={(e) => setAlign(e.target.value as ImageAlign | '')}>
            <option value="">Left, on its own line</option>
            {IMAGE_ALIGNS.map((a) => (
              <option key={a} value={a}>
                {ALIGN_LABEL[a]}
              </option>
            ))}
          </Select>
        </div>
        <Field
          label="Link"
          value={href}
          placeholder="https://… or /page"
          onChange={(e) => setHref(e.target.value)}
          hint="Optional: where clicking the image goes."
        />
        <div className="flex gap-2">
          <Button onClick={() => void save()}>Apply</Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-black/60">Changes show on the site when you save the page.</p>
      </div>
    </Dialog>
  )
}
