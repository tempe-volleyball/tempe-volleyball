// The parts of the WordPress / SportsPress REST responses the importer reads.

export type Rendered = { rendered: string }

export type WpTerm = { id: number; name: string; slug: string; count: number; description?: string }

export type WpPage = {
  id: number
  date: string
  date_gmt: string
  modified_gmt: string
  slug: string
  status: string
  link: string
  title: Rendered
  content: Rendered
  excerpt: Rendered
  featured_media: number
  parent: number
}

export type WpPost = WpPage & { categories: number[] }

export type WpMedia = {
  id: number
  date_gmt: string
  slug: string
  source_url: string
  mime_type: string
  alt_text: string
  title: Rendered
  media_details?: {
    width?: number
    height?: number
    filesize?: number
    sizes?: Record<string, { source_url: string; width: number; height: number }>
  }
}

export type SpEvent = {
  id: number
  /** Site-local (Sydney) date and time of the match, "2026-10-15T21:00:00". */
  date: string
  date_gmt: string
  modified_gmt: string
  slug: string
  status: string
  link: string
  title: Rendered
  leagues: number[]
  seasons: number[]
  venues: number[]
  /** Home, away. -1 = placeholder (finals not yet decided, byes). */
  teams: number[]
  results: unknown
  minutes?: string
}

export type SpTeam = { id: number; slug: string; link: string; title: Rendered; leagues: number[]; seasons: number[] }

export type SpTable = {
  id: number
  slug: string
  link: string
  title: Rendered
  leagues: number[]
  seasons: number[]
  data: Record<string, Record<string, unknown>>
}

export type SpCalendar = { id: number; slug: string; link: string; title: Rendered; leagues: number[]; seasons: number[] }

export type WpData = {
  pages: WpPage[]
  posts: WpPost[]
  media: WpMedia[]
  categories: WpTerm[]
  events: SpEvent[]
  teams: SpTeam[]
  leagues: WpTerm[]
  seasons: WpTerm[]
  venues: WpTerm[]
  tables: SpTable[]
  calendars: SpCalendar[]
}
