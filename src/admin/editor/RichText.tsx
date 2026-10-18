import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react'
import { useMemo, useState, type ReactNode } from 'react'
import { importLosses, isUnconvertedImport } from '../../lib/content/import-check'
import { safeHref } from '../../lib/content/render'
import type { ContentBody, MediaItem } from '../api'
import { MediaPicker } from '../media/MediaLibrary'
import { Button, Dialog, Notice } from '../ui'
import { DATA_BLOCK_LABELS, dataBlockExtensions, type DataBlockType } from './data-blocks'
import { ImageSettings, type ImageAttrs } from './ImageSettings'
import { SlashMenu, slashItems, type SlashItem, type SlashState } from './SlashMenu'
import { embedUrl, editorExtensions } from './extensions'

// The rich-text editor (TipTap) for pages and posts. It edits the body's JSON blocks; the server renders and
// sanitises the public HTML from them on save (src/lib/content/render.ts). Imported pages that only have HTML are
// parsed into blocks when opened.

export type RichTextProps = {
  initial: ContentBody
  onChange: (blocks: unknown[]) => void
  label?: string
  /** Offer the data blocks (Programme list, Ladder, Fixtures). Pages only: they render live on the public page. */
  dataBlocks?: boolean
  /** Whether a save keeps the previous version as a revision (pages do, posts don't); worded into the import notice. */
  keepsRevisions?: boolean
}

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
      <span aria-hidden="true">{children}</span>
    </button>
  )
}

const Sep = () => <span className="mx-1 h-6 w-px bg-black/15" aria-hidden />

function Toolbar({
  editor,
  onImage,
  onImageSettings,
  dataBlocks,
}: {
  editor: Editor
  onImage: () => void
  onImageSettings: () => void
  dataBlocks?: boolean
}) {
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
      button: e.isActive('link', { variant: 'button' }),
      image: e.isActive('image'),
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
      {s.link && (
        <ToolButton
          label="Show the link as a button"
          active={s.button}
          onClick={() =>
            chain()
              .extendMarkRange('link')
              .updateAttributes('link', { variant: s.button ? null : 'button' })
              .run()
          }
        >
          Button
        </ToolButton>
      )}
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
      <ToolButton label="Image (or type / on an empty line)" onClick={onImage}>
        Image
      </ToolButton>
      {s.image && (
        <ToolButton
          label="Image settings: description, caption, size, alignment, link (or double-click the image)"
          onClick={onImageSettings}
        >
          Image settings…
        </ToolButton>
      )}
      <ToolButton label="Embed video or map" onClick={addEmbed}>
        Embed
      </ToolButton>
      <ToolButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}>
        ―
      </ToolButton>
      {dataBlocks && (
        <select
          aria-label="Insert a data block"
          title="Insert a data block (or type / on an empty line, then pick one)"
          className="rounded border border-black/20 bg-white px-1 py-1 text-sm"
          value=""
          onChange={(e) => {
            const type = e.target.value as DataBlockType
            // A paragraph after it, so typing (or the next block) goes below instead of replacing the selected block.
            if (type)
              chain()
                .insertContent([{ type }, { type: 'paragraph' }])
                .run()
          }}
        >
          <option value="">+ Block…</option>
          {(Object.keys(DATA_BLOCK_LABELS) as DataBlockType[]).map((t) => (
            <option key={t} value={t}>
              {DATA_BLOCK_LABELS[t]}
            </option>
          ))}
        </select>
      )}
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

/**
 * Shown above an imported body that hasn't been saved in the editor yet: what the first save converts, and the
 * original to compare with (src/lib/content/import-check.ts).
 */
function ImportNotice({ html, keepsRevisions }: { html: string; keepsRevisions: boolean }) {
  const losses = useMemo(() => importLosses(html), [html])
  const [showing, setShowing] = useState(false)
  return (
    <Notice kind={losses.length ? 'warning' : 'info'}>
      <p>
        This was imported from the old site and hasn't been saved in the editor yet. Saving converts it to the editor's format
        {keepsRevisions
          ? '; the original stays in Revisions, so you can go back to it.'
          : '. Posts have no revisions, so check the result before you save; leaving without saving keeps the original.'}
      </p>
      {losses.length > 0 ? (
        <>
          <p className="mt-2 font-semibold">These won't come across exactly:</p>
          <ul className="mt-1 list-disc pl-5">
            {losses.map((l) => (
              <li key={l.label}>
                {l.label}
                {l.count > 1 ? ` (${l.count})` : ''}: {l.effect}.
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1">Everything on it is supported, so it should look the same.</p>
      )}
      <Button variant="link" onClick={() => setShowing(true)}>
        View the original
      </Button>
      {showing && (
        <Dialog title="The imported original" onCancel={() => setShowing(false)} wide>
          <div className="rich-text rounded border border-black/10 p-4" dangerouslySetInnerHTML={{ __html: html }} />
        </Dialog>
      )}
    </Notice>
  )
}

export function RichText({ initial, onChange, label = 'Content', dataBlocks = false, keepsRevisions = true }: RichTextProps) {
  // 'insert' adds a new image; 'replace' swaps the selected image's file and keeps its caption and layout.
  const [picking, setPicking] = useState<'insert' | 'replace' | null>(null)
  const [imageEdit, setImageEdit] = useState<ImageAttrs | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [imported] = useState(() => (isUnconvertedImport(initial) ? initial.html : null))
  const editor = useEditor({
    extensions: dataBlocks ? [...editorExtensions(), ...dataBlockExtensions()] : editorExtensions(),
    content: initialContent(initial),
    editorProps: {
      attributes: { class: 'rich-text min-h-80 px-4 py-3 outline-none', 'aria-label': label },
      // "/" on an empty line opens the insert menu (data blocks, image, table …).
      handleKeyDown: (view, event) => {
        if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return false
        const { $from, empty } = view.state.selection
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) return false
        const at = view.coordsAtPos($from.pos)
        setSlash({ top: at.bottom, left: at.left })
        return true
      },
      handleDOMEvents: {
        // The first click selects the image; the double-click opens its settings.
        dblclick: (view) => {
          const node = (view.state.selection as { node?: { type: { name: string }; attrs: unknown } }).node
          if (node?.type.name !== 'image') return false
          setImageEdit(node.attrs as ImageAttrs)
          return true
        },
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON().content ?? []),
  })

  const pickedImage = (m: MediaItem) => {
    const mode = picking
    setPicking(null)
    const file = { src: m.urls.src, srcset: m.urls.srcset, width: m.width, height: m.height }
    if (mode === 'replace') {
      editor?.chain().focus().updateAttributes('image', file).run()
      setImageEdit((a) => (a ? { ...a, ...file, alt: a.alt || m.alt } : a))
      return
    }
    editor
      ?.chain()
      .focus()
      .insertContent({ type: 'image', attrs: { ...file, alt: m.alt } })
      .run()
  }

  const runSlash = (item: SlashItem) => {
    setSlash(null)
    if (!editor) return
    if (item.kind === 'image') return setPicking('insert')
    item.run(editor)
  }

  return (
    <div className="space-y-2">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {imported && <ImportNotice html={imported} keepsRevisions={keepsRevisions} />}
      <div className="focus-within:border-brand rounded border border-black/20 bg-white">
        {editor && (
          <Toolbar
            editor={editor}
            onImage={() => setPicking('insert')}
            onImageSettings={() => setImageEdit(editor.getAttributes('image') as ImageAttrs)}
            dataBlocks={dataBlocks}
          />
        )}
        <EditorContent editor={editor} />
      </div>
      {picking && <MediaPicker onPick={pickedImage} onCancel={() => setPicking(null)} />}
      {imageEdit && !picking && (
        <ImageSettings
          attrs={imageEdit}
          onCancel={() => {
            setImageEdit(null)
            editor?.commands.focus()
          }}
          onReplace={() => setPicking('replace')}
          onSave={(attrs) => {
            setImageEdit(null)
            editor?.chain().focus().updateAttributes('image', attrs).run()
          }}
        />
      )}
      {slash && editor && (
        <SlashMenu
          at={slash}
          items={slashItems(dataBlocks)}
          onPick={runSlash}
          onCancel={(text) => {
            setSlash(null)
            // Escape types the "/" (and anything typed after it) as text after all.
            if (text) editor.chain().focus().insertContent(text).run()
            else editor.commands.focus()
          }}
        />
      )}
    </div>
  )
}
