import { Suspense, lazy } from 'react'
import type { RichTextProps } from './RichText'

// The editor (TipTap + ProseMirror) is most of the admin's JavaScript, so it loads only on the screens that use it.

const Editor = lazy(() => import('./RichText').then((m) => ({ default: m.RichText })))

export function RichText(props: RichTextProps) {
  return (
    <Suspense
      fallback={<div className="min-h-80 rounded border border-black/20 bg-white p-4 text-sm text-black/60">Loading the editor…</div>}
    >
      <Editor {...props} />
    </Suspense>
  )
}
