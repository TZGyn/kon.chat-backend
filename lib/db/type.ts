import type { InferSelectModel } from 'drizzle-orm'
import { chat, message, user } from './schema'

export type User = InferSelectModel<typeof user>
export type Chat = InferSelectModel<typeof chat>
export type Message = InferSelectModel<typeof message>
