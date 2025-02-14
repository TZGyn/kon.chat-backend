import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'

const client = new Bun.SQL(Bun.env.DATABASE_URL!)

export const db = drizzle(client, { schema })
