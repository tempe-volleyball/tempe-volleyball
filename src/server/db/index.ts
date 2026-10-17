import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

/** A Drizzle client for one request. Cheap to create, so make one per request rather than sharing it. */
export const getDb = (d1: D1Database) => drizzle(d1, { schema })

export type Db = ReturnType<typeof getDb>
