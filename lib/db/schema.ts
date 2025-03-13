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
	googleId: varchar('google_id', { length: 255 }),
	avatar: text('avatar'),
	githubId: varchar('github_id', { length: 255 }),
	username: varchar('username', { length: 255 }).notNull(),
	email: varchar('email', { length: 255 }).notNull(),
	standardChatLimit: bigint('standard_chat_limit', { mode: 'number' })
		.notNull()
		.default(0),
	premiumChatLimit: bigint('premium_chat_limit', { mode: 'number' })
		.notNull()
		.default(0),
	standardChatCredit: bigint('standard_chat_credit', {
		mode: 'number',
	})
		.notNull()
		.default(0),
	premiumChatCredit: bigint('premium_chat_credit', {
		mode: 'number',
	})
		.notNull()
		.default(0),
	searchLimit: bigint('search_limit', {
		mode: 'number',
	})
		.notNull()
		.default(0),
	searchCredit: bigint('search_credit', {
		mode: 'number',
	})
		.notNull()
		.default(0),
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

export const youtube = pgTable('youtube', (t) => ({
	id: t.varchar('id', { length: 255 }).primaryKey().notNull(),
	channelName: t.text('channel_name').notNull(),
	channelUrl: t.varchar('channel_url', { length: 255 }).notNull(),
	channelThumbnailUrl: t.text('channel_thumbnail_url').notNull(),
	title: t.text('title').notNull(),
	description: t.text('description').notNull(),
	descriptionHTML: t.text('description_html').notNull(),
	transcript: t.json('transcript').notNull(),
	summary: t.text('summary').notNull(),
	uploadTime: t.text('upload_time').notNull(),
	createdAt: t.bigint('created_at', { mode: 'number' }).notNull(),
}))

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
}))

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
