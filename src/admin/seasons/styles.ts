// Shared by the season screen's tabs and dialogs. Kept out of the tabs themselves so importing it doesn't pull a
// lazily loaded tab (SetupTab, FixturesTab) into the Results tab's chunk.

export const inputClass =
  'focus:border-brand focus:ring-brand/30 w-full rounded border border-black/20 bg-white px-3 py-2 text-sm outline-none focus:ring-2 disabled:bg-black/5'
