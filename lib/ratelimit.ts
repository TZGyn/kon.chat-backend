import { generateId } from 'ai'
import { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '$lib/auth/session'
import { redis } from '$lib/redis'
import { encodeHexLowerCase } from '@oslojs/encoding'
import { sha256 } from '@oslojs/crypto/sha2'
import { User } from '$lib/db/type'
import { premiumModels, Provider, standardModels } from '$lib/model'
import { user } from '$lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { db } from '$lib/db'

export type Limit = {
	plan: 'free' | 'basic' | 'pro' | 'owner' | 'trial'
	freeLimit: number
	standardLimit: number
	premiumLimit: number
	standardCredit: number
	premiumCredit: number
	searchLimit: number
	searchCredit: number
}

export const checkRatelimit = async ({
	c,
	search,
	mode,
}: {
	c: Context
	search: boolean
	mode: 'x_search' | 'chat'
}) => {
	let token = getCookie(c, 'session') ?? null
	let cookie: 'none' | 'set' | 'delete' = 'none'
	if (!token) {
		token = `free:${generateId()}`
		cookie = 'set'
		await redis.set(
			token + '-limit',
			{
				plan: 'trial',
				freeLimit: 10,
				standardLimit: 0,
				premiumLimit: 0,
				standardCredit: 0,
				premiumCredit: 0,
				searchLimit: 0,
				searchCredit: 0,
			},
			{ ex: 60 * 60 * 24 },
		)
	}

	let limit = await redis.get<Limit>(
		(token.startsWith('free:')
			? token
			: encodeHexLowerCase(sha256(new TextEncoder().encode(token)))) +
			'-limit',
	)

	if (!limit) {
		if (token.startsWith('free:')) {
			return { error: 'You have been rate limited' }
		} else {
			const { session, user } = await validateSessionToken(token)
			if (!user) return { error: 'Invalid User' }

			if (session !== null) {
				cookie = 'set'
			} else {
				cookie = 'delete'
			}

			limit = {
				plan: user.plan,
				freeLimit: 0,
				standardCredit: user.standardChatCredit,
				premiumCredit: user.premiumChatCredit,
				premiumLimit: user.premiumChatLimit,
				standardLimit: user.standardChatLimit,
				searchCredit: user.searchCredit,
				searchLimit: user.searchLimit,
			}
		}
	}

	if (
		(search || mode !== 'chat') &&
		limit.searchCredit + limit.searchLimit <= 0
	) {
		return { error: 'You have reached the limit for search' }
	}

	return { limit, token, cookie }
}

export const updateUserRatelimit = async ({
	user: loggedInUser,
	search,
	provider,
	mode,
}: {
	user: User
	search: boolean
	provider: Provider
	mode: 'x_search' | 'chat'
}) => {
	if (provider.model === 'gemini-2.0-flash-001') return
	const minusSearchLimit =
		loggedInUser.searchLimit > 0 && (search || mode !== 'chat')
	const minusSearchCredit =
		!minusSearchLimit &&
		loggedInUser.searchCredit > 0 &&
		(search || mode !== 'chat')

	const minusStandardLimit =
		loggedInUser.standardChatLimit > 0 &&
		standardModels.includes(provider.model)
	const minusStandardCredit =
		!minusStandardLimit &&
		loggedInUser.standardChatCredit > 0 &&
		standardModels.includes(provider.model)

	const minusPremiumLimit =
		loggedInUser.premiumChatLimit > 0 &&
		premiumModels.includes(provider.model)
	const minusPremiumCredit =
		!minusPremiumLimit &&
		loggedInUser.premiumChatCredit > 0 &&
		premiumModels.includes(provider.model)

	const [updatedUser] = await db
		.update(user)
		.set({
			searchLimit: sql`${user.searchLimit} - ${
				minusSearchLimit ? '1' : '0'
			}`,
			searchCredit: sql`${user.searchCredit} - ${
				minusSearchCredit ? '1' : '0'
			}`,
			standardChatLimit: sql`${user.standardChatLimit} - ${
				minusStandardLimit ? '1' : '0'
			}`,
			standardChatCredit: sql`${user.standardChatCredit} - ${
				minusStandardCredit ? '1' : '0'
			}`,
			premiumChatLimit: sql`${user.premiumChatLimit} - ${
				minusPremiumLimit ? '1' : '0'
			}`,
			premiumChatCredit: sql`${user.premiumChatCredit} - ${
				minusPremiumCredit ? '1' : '0'
			}`,
		})
		.where(eq(user.id, loggedInUser.id))
		.returning()

	const currentUser = await db.query.user.findFirst({
		where: (user, { eq }) => eq(user.id, loggedInUser.id),
		with: {
			sessions: {
				where: (session, { gte }) =>
					gte(session.expiresAt, Date.now()),
			},
		},
	})

	if (!currentUser) return

	await Promise.all(
		currentUser.sessions.map(async (session) => {
			await redis.set(
				session.id + '-limit',
				{
					plan: updatedUser.plan,
					freeLimit: 0,
					standardLimit: updatedUser.standardChatLimit,
					premiumLimit: updatedUser.premiumChatLimit,
					standardCredit: updatedUser.standardChatCredit,
					premiumCredit: updatedUser.premiumChatCredit,
					searchLimit: updatedUser.searchLimit,
					searchCredit: updatedUser.searchCredit,
				},
				{ ex: 60 * 60 * 24 },
			)
		}),
	)
}

export const syncUserRatelimitWithDB = async (userId: string) => {
	const currentUser = await db.query.user.findFirst({
		where: (user, { eq }) => eq(user.id, userId),
		with: {
			sessions: {
				where: (session, { gte }) =>
					gte(session.expiresAt, Date.now()),
			},
		},
	})

	if (!currentUser) return

	await Promise.all(
		currentUser.sessions.map(async (session) => {
			await redis.set(
				session.id + '-limit',
				{
					plan: currentUser.plan,
					freeLimit: 0,
					standardLimit: currentUser.standardChatLimit,
					premiumLimit: currentUser.premiumChatLimit,
					standardCredit: currentUser.standardChatCredit,
					premiumCredit: currentUser.premiumChatCredit,
					searchLimit: currentUser.searchLimit,
					searchCredit: currentUser.searchCredit,
				},
				{ ex: 60 * 60 * 24 },
			)
		}),
	)
}
