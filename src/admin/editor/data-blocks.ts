import { Node, type Extensions } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { DEFAULT_FIXTURES_ATTRS, DEFAULT_LADDER_ATTRS, DEFAULT_PROGRAMME_LIST_ATTRS, type DataBlock } from '../../lib/content/blocks'
import { DataBlockView } from './DataBlockView'

// The page editor's data blocks (docs/admin.md §3.4) as TipTap atom nodes. Their attrs are the block's settings
// (src/lib/content/blocks.ts); the server normalises them on save and renders the block from live data on the public
// page (src/lib/content/data-blocks.ts). In the editor each shows a live preview and a settings dialog.

export type DataBlockType = DataBlock['type']

export const DATA_BLOCK_LABELS: Record<DataBlockType, string> = {
  programmeList: 'Programme list',
  ladder: 'Ladder',
  fixtures: 'Fixtures',
}

const DEFAULTS: Record<DataBlockType, Record<string, unknown>> = {
  programmeList: DEFAULT_PROGRAMME_LIST_ATTRS,
  ladder: { leagueId: '', ...DEFAULT_LADDER_ATTRS },
  fixtures: { leagueId: '', ...DEFAULT_FIXTURES_ATTRS },
}

const dataBlock = (name: DataBlockType) =>
  Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      // `rendered: false`: the attrs travel as one JSON data attribute (renderHTML), for copy and paste.
      return Object.fromEntries(Object.entries(DEFAULTS[name]).map(([k, v]) => [k, { default: v, rendered: false }]))
    },
    parseHTML() {
      return [
        {
          tag: `div[data-tvb-block="${name}"]`,
          getAttrs: (el) => {
            try {
              const a = JSON.parse((el as HTMLElement).getAttribute('data-attrs') ?? '{}') as unknown
              return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {}
            } catch {
              return {}
            }
          },
        },
      ]
    },
    renderHTML({ node }) {
      return ['div', { 'data-tvb-block': name, 'data-attrs': JSON.stringify(node.attrs) }]
    },
    addNodeView() {
      return ReactNodeViewRenderer(DataBlockView)
    },
  })

export const dataBlockExtensions = (): Extensions => [dataBlock('programmeList'), dataBlock('ladder'), dataBlock('fixtures')]
