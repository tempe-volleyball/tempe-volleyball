import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react'
import { useState, type ReactNode } from 'react'
import { safeHref } from '../../lib/content/render'
import type { ContentBody, MediaItem } from '../api'
import { MediaPicker } from '../media/MediaLibrary'
import { embedUrl, editorExtensions } from './extensions'

// The rich-text editor (TipTap) for pages and posts. It edits the body's JSON blocks; the server renders and
// sanitises the public HTML from them on save (src/lib/content/render.ts). Imported pages that only have HTML are
// parsed into blocks when opened.

export type RichTextProps = { initial: ContentBody; onChange: (blocks: unknown[]) => void; label?: string }

const initialContent = (body: ContentBody): JSONContent | string =>
  Array.isArray(body.blocks) && body.blocks.length ? { type: 'doc', content: body.blocks as JSONContent[] } : body.html || '<p></p>'

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`min-w-8 rounded px-2 py-1 text-sm font-semibold disabled:opacity-40 ${active ? 'bg-brand text-white' : 'hover:bg-black/10'}`}
    >
      {children}
    </button>
  )
}

const Sep = () => <span className="mx-1 h-6 w-px bg-black/15" aria-hidden />

function Toolbar({ editor, onImage }: { editor: Editor; onImage: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 2 })
        ? 'h2'
        : e.isActive('heading', { level: 3 })
          ? 'h3'
          : e.isActive('heading', { level: 4 })
            ? 'h4'
            : e.isActive('heading', { level: 1 })
              ? 'h2'
              : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      table: e.isActive('table'),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const chain = () => editor.chain().focus()

  const setLink = () => {
    const current = (editor.getAttributes('link').href as string | undefined) ?? ''
    const input = window.prompt('Link address (https://…, /page or mailto:…). Leave empty to remove the link.', current)
    if (input === null) return
    const href = input.trim()
    if (!href) return void chain().extendMarkRange('link').unsetLink().run()
    const normalised = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(href) ? `https://${href}` : href
    if (!safeHref(normalised)) return window.alert('That link isn’t allowed. Use https://…, a /path, mailto: or tel:.')
    chain().extendMarkRange('link').setLink({ href: normalised }).run()
  }

  const addEmbed = () => {
    const input = window.prompt('Paste a YouTube or Vimeo link, or a Google Maps “Embed a map” code.')
    if (!input) return
    const src = embedUrl(input)
    if (!src) return window.alert('Only YouTube, Vimeo and Google Maps/Docs can be embedded.')
    chain()
      .insertContent({ type: 'embed', attrs: { src, title: 'Embedded content' } })
      .run()
  }

  return (
    <div
      className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-black/10 bg-white/95 p-1 backdrop-blur"
      role="toolbar"
      aria-label="Formatting"
    >
      <select
        aria-label="Text style"
        className="rounded border border-black/20 bg-white px-1 py-1 text-sm"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') chain().setParagraph().run()
          else
            chain()
              .setHeading({ level: Number(v.slice(1)) as 2 | 3 | 4 })
              .run()
        }}
      >
        <option value="p">Paragraph</option>
        <option value="h2">Heading</option>
        <option value="h3">Subheading</option>
        <option value="h4">Small heading</option>
      </select>
      <Sep />
      <ToolButton label="Bold" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <i>I</i>
      </ToolButton>
      <ToolButton label="Underline" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <u>U</u>
      </ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <s>S</s>
      </ToolButton>
      <ToolButton label="Link" active={s.link} onClick={setLink}>
        Link
      </ToolButton>
      <Sep />
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        • List
      </ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        1. List
      </ToolButton>
      <ToolButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        “ ”
      </ToolButton>
      <ToolButton
        label="Centre"
        active={s.center}
        onClick={() => (s.center ? chain().unsetTextAlign().run() : chain().setTextAlign('center').run())}
      >
        ≡c
      </ToolButton>
      <ToolButton
        label="Align right"
        active={s.right}
        onClick={() => (s.right ? chain().unsetTextAlign().run() : chain().setTextAlign('right').run())}
      >
        ≡r
      </ToolButton>
      <Sep />
      <ToolButton label="Image" onClick={onImage}>
        Image
      </ToolButton>
      <ToolButton label="Embed video or map" onClick={addEmbed}>
        Embed
      </ToolButton>
      <ToolButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}>
        ―
      </ToolButton>
      {s.table ? (
        <>
          <ToolButton label="Add row" onClick={() => chain().addRowAfter().run()}>
            +Row
          </ToolButton>
          <ToolButton label="Add column" onClick={() => chain().addColumnAfter().run()}>
            +Col
          </ToolButton>
          <ToolButton label="Delete row" onClick={() => chain().deleteRow().run()}>
            −Row
          </ToolButton>
          <ToolButton label="Delete column" onClick={() => chain().deleteColumn().run()}>
            −Col
          </ToolButton>
          <ToolButton label="Delete table" onClick={() => chain().deleteTable().run()}>
            ×Table
          </ToolButton>
        </>
      ) : (
        <ToolButton label="Table" onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          Table
        </ToolButton>
      )}
      <Sep />
      <ToolButton label="Undo" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
        ↶
      </ToolButton>
      <ToolButton label="Redo" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
        ↷
      </ToolButton>
    </div>
  )
}

export function RichText({ initial, onChange, label = 'Content' }: RichTextProps) {
  const [picking, setPicking] = useState(false)
  const editor = useEditor({
    extensions: editorExtensions(),
    content: initialContent(initial),
    editorProps: { attributes: { class: 'rich-text min-h-80 px-4 py-3 outline-none', 'aria-label': label } },
    onUpdate: ({ editor: e }) => onChange(e.getJSON().content ?? []),
  })

  const insertImage = (m: MediaItem) => {
    setPicking(false)
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: 'image',
        attrs: { src: m.urls.src, srcset: m.urls.srcset, alt: m.alt, width: m.width, height: m.height },
      })
      .run()
  }

  return (
    <div>
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <div className="focus-within:border-brand rounded border border-black/20 bg-white">
        {editor && <Toolbar editor={editor} onImage={() => setPicking(true)} />}
        <EditorContent editor={editor} />
      </div>
      {picking && <MediaPicker onPick={insertImage} onCancel={() => setPicking(false)} />}
    </div>
  )
}
