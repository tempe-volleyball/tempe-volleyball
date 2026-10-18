import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { DATA_BLOCK_LABELS, type DataBlockType } from './data-blocks'
import { embedUrl } from './extensions'

// The "/" menu: type / on an empty line, then a few letters to filter, ↑/↓ and Enter to insert (or click).
// Escape types the "/" as text after all. It's the keyboard way to add a data block, an image, a table …

export type SlashState = { top: number; left: number }

export type SlashItem =
  | { kind: 'image'; label: string; hint: string; keywords: string }
  | { kind: 'run'; label: string; hint: string; keywords: string; run: (editor: Editor) => void }

const block = (type: DataBlockType): SlashItem => ({
  kind: 'run',
  label: DATA_BLOCK_LABELS[type],
  hint: 'Data block: live from the season and programme data',
  keywords: `${DATA_BLOCK_LABELS[type]} block data ${type}`.toLowerCase(),
  // A paragraph after it, so typing goes below. The empty line the menu was opened on is replaced.
  run: (e) =>
    e
      .chain()
      .focus()
      .insertContent([{ type }, { type: 'paragraph' }])
      .run(),
})

/** What the menu offers: the data blocks (pages only), then the other things you can insert. */
export function slashItems(dataBlocks: boolean): SlashItem[] {
  return [
    ...(dataBlocks ? (Object.keys(DATA_BLOCK_LABELS) as DataBlockType[]).map(block) : []),
    { kind: 'image', label: 'Image', hint: 'From the media library', keywords: 'image picture photo media' },
    {
      kind: 'run',
      label: 'Table',
      hint: '3 × 3 with a header row',
      keywords: 'table grid',
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      kind: 'run',
      label: 'Embed video or map',
      hint: 'YouTube, Vimeo or Google Maps',
      keywords: 'embed video youtube vimeo map google iframe',
      run: (e) => {
        const input = window.prompt('Paste a YouTube or Vimeo link, or a Google Maps “Embed a map” code.')
        const src = input ? embedUrl(input) : null
        if (input && !src) window.alert('Only YouTube, Vimeo and Google Maps/Docs can be embedded.')
        if (src)
          e.chain()
            .focus()
            .insertContent({ type: 'embed', attrs: { src, title: 'Embedded content' } })
            .run()
      },
    },
    {
      kind: 'run',
      label: 'Heading',
      hint: 'A section heading',
      keywords: 'heading title h2',
      run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      kind: 'run',
      label: 'Bulleted list',
      hint: '',
      keywords: 'list bullet ul',
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      kind: 'run',
      label: 'Horizontal line',
      hint: '',
      keywords: 'line rule divider hr',
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
  ]
}

export function SlashMenu({
  at,
  items,
  onPick,
  onCancel,
}: {
  at: SlashState
  items: SlashItem[]
  onPick: (item: SlashItem) => void
  /** Closed without picking: `text` is what to type in its place ("/" plus the filter), '' for nothing. */
  onCancel: (text: string) => void
}) {
  const [q, setQ] = useState('')
  // Once picked or cancelled, a late blur (the menu unmounting) mustn't cancel again.
  const done = useRef(false)
  const finish = (fn: () => void) => {
    if (done.current) return
    done.current = true
    fn()
  }
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = items.filter((i) => words.every((w) => i.keywords.includes(w) || i.label.toLowerCase().includes(w)))
  const current = Math.min(active, Math.max(shown.length - 1, 0))

  useEffect(() => input.current?.focus(), [])

  // Keep it on screen: below the caret, or above it near the bottom of the window.
  const top = Math.min(at.top + 4, window.innerHeight - 320)
  const left = Math.min(at.left, window.innerWidth - 300)

  return (
    <div
      className="fixed z-50 w-72 rounded border border-black/20 bg-white shadow-xl"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
      onMouseDown={(e) => {
        // Keep focus in the filter box (clicks on items still fire).
        if (e.target !== input.current) e.preventDefault()
      }}
    >
      <input
        ref={input}
        aria-label="Insert"
        role="combobox"
        aria-expanded="true"
        aria-controls="slash-menu-list"
        aria-activedescendant={shown[current] ? `slash-item-${current}` : undefined}
        className="w-full border-b border-black/10 px-3 py-2 text-sm outline-none"
        placeholder="Insert… (type to filter)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
        }}
        onBlur={() => finish(() => onCancel(`/${q}`))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((current + 1) % Math.max(shown.length, 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((current - 1 + shown.length) % Math.max(shown.length, 1))
          } else if (e.key === 'Enter') {
            // Never let Enter submit the page form around the editor.
            e.preventDefault()
            const item = shown[current]
            if (item) finish(() => onPick(item))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            finish(() => onCancel(`/${q}`))
          } else if (e.key === 'Backspace' && q === '') {
            // Deletes the "/" that opened the menu.
            e.preventDefault()
            finish(() => onCancel(''))
          }
        }}
      />
      <ul id="slash-menu-list" role="listbox" className="max-h-72 overflow-y-auto py-1 text-sm">
        {shown.length === 0 && <li className="px-3 py-2 text-black/60">Nothing matches. Escape types a “/”.</li>}
        {shown.map((item, i) => (
          <li
            key={item.label}
            id={`slash-item-${i}`}
            role="option"
            aria-selected={i === current}
            className={`cursor-pointer px-3 py-1.5 ${i === current ? 'bg-brand text-white' : 'hover:bg-black/5'}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => finish(() => onPick(item))}
          >
            <span className="block font-semibold">{item.label}</span>
            {item.hint && <span className={`block text-xs ${i === current ? 'text-white/80' : 'text-black/60'}`}>{item.hint}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
