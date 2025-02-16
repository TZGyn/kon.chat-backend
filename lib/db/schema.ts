import {
	pgTable,
	varchar,
	text,
	bigint,
	json,
	integer,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	googleId: varchar('google_id', { length: 255 }).notNull(),
	username: varchar('username', { length: 255 }).notNull(),
	email: varchar('email', { length: 255 }).notNull(),
	credit: bigint('credit', { mode: 'number' }).notNull(),
	polarCustomerId: varchar('polar_customer_id', { length: 255 }),
	plan: varchar('plan', { length: 255 })
		.notNull()
		.$type<'free' | 'pro' | 'basic' | 'owner'>()
		.default('free'),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	expiresAt: bigint('expires_at_epoch', { mode: 'number' }).notNull(),
})

export const chat = pgTable('chat', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	title: text('title').notNull(),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const message = pgTable('message', {
	id: text('id').primaryKey().notNull(),
	chatId: text('chat_id').notNull(),
	role: varchar('role').notNull(),
	braveData: json('brave_data').notNull().default({}),
	jinaData: json('jina_data').notNull().default([]),
	content: json('content').notNull(),
	model: varchar('model'),
	provider: varchar('provider'),
	providerMetadata: json('provider_metadata').notNull().default({}),
	promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
	completionTokens: bigint('completion_tokens', {
		mode: 'number',
	}).notNull(),
	totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}))

export const chatRelations = relations(chat, ({ one, many }) => ({
	user: one(user, {
		fields: [chat.userId],
		references: [user.id],
	}),
	messages: many(message),
}))

export const messageRelations = relations(message, ({ one }) => ({
	chat: one(chat, {
		fields: [message.chatId],
		references: [chat.id],
	}),
}))
