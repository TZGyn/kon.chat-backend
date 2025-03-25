import {
	pgTable,
	varchar,
	text,
	bigint,
	json,
	integer,
	vector,
	index,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	googleId: varchar('google_id', { length: 255 }),
	avatar: text('avatar'),
	githubId: varchar('github_id', { length: 255 }),
	username: varchar('username', { length: 255 }).notNull(),
	email: varchar('email', { length: 255 }).notNull(),
	credits: bigint('credits', { mode: 'number' }).notNull().default(0),
	purchasedCredits: bigint('purchased_credits', { mode: 'number' })
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

export const upload = pgTable('upload', (t) => ({
	id: t.text('id').primaryKey(),
	userId: text('user_id').notNull(),
	key: t.text('key').notNull(),
	name: t.text('name').notNull(),
	size: t.bigint('size', { mode: 'number' }).notNull(),
	mimeType: t.varchar('mime_type', { length: 255 }).notNull(),
	visibility: t
		.varchar('visibility', { length: 255 })
		.$type<'private' | 'public'>()
		.notNull()
		.default('private'),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}))

export const chat = pgTable('chat', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	title: text('title').notNull(),
	visibility: varchar('visibility', { length: 255 })
		.$type<'private' | 'public'>()
		.notNull()
		.default('private'),
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

export const document = pgTable('document', (t) => ({
	id: t.varchar('id', { length: 255 }).primaryKey().notNull(),
	userId: text('user_id').notNull(),
	type: t.varchar('type').$type<'pdf'>().notNull(),
	name: t.varchar('name', { length: 255 }).notNull(),
	uploadId: t.text('upload_id').notNull(),
	markdown: t.text('markdown'),
	summary: t.text('summary'),
	createdAt: t.bigint('created_at', { mode: 'number' }).notNull(),
}))

export const embeddings = pgTable(
	'embeddings',
	{
		id: varchar('id', { length: 255 }).primaryKey(),
		resourceType: varchar('resource_type', { length: 255 })
			.$type<'document'>()
			.notNull(),
		resourceId: varchar('resource_id', { length: 255 }).notNull(),
		content: text('content').notNull(),
		embedding: vector('embedding', { dimensions: 768 }).notNull(),
	},
	(table) => [
		index('embeddingIndex').using(
			'hnsw',
			table.embedding.op('vector_cosine_ops'),
		),
	],
)

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

export const documentRelations = relations(document, ({ one }) => ({
	upload: one(upload, {
		fields: [document.uploadId],
		references: [upload.id],
	}),
}))
