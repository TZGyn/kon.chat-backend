import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { User } from '../../lib/db/type'
import { getCookie, setCookie } from 'hono/cookie'
import {
	createSession,
	deleteSessionTokenCookie,
	generateSessionToken,
	invalidateSession,
	setSessionTokenCookie,
	validateSessionToken,
} from '../../lib/auth/session'
import {
	decodeIdToken,
	generateCodeVerifier,
	generateState,
	OAuth2Tokens,
} from 'arctic'
import { google } from '../../lib/auth/provider'
import { db } from '../../lib/db'
import { user } from '../../lib/db/schema'
import { redis } from '../../lib/redis'

const app = new Hono()

app.get('/me', async (c) => {
	const token = getCookie(c, 'session') ?? null

	if (token === null) {
		return c.json({ user: null })
	}

	if (token.startsWith('free:')) {
		let limit = await redis.get<{
			plan: 'free' | 'basic' | 'pro' | 'owner'
			standardLimit: number
			premiumLimit: number
			standardCredit: number
			premiumCredit: number
			searchLimit: number
			searchCredit: number
		}>(token + '-limit')
		if (!limit) return c.json({ user: null })

		return c.json({
			user: {
				email: '',
				name: '',
				plan: 'free',
				standardChatLimit: limit.standardLimit,
				premiumChatLimit: limit.premiumLimit,
				standardChatCredit: limit.standardCredit,
				premiumChatCredit: limit.premiumCredit,
				searchLimit: limit.searchLimit,
				searchCredit: limit.searchCredit,
			},
		})
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		return c.json({ user: null })
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	return c.json({
		user: user
			? {
					email: user.email,
					name: user.username,
					plan: user.plan,
					standardChatLimit: user.standardChatLimit,
					premiumChatLimit: user.premiumChatLimit,
					standardChatCredit: user.standardChatCredit,
					premiumChatCredit: user.premiumChatCredit,
					searchLimit: user.searchLimit,
					searchCredit: user.searchCredit,
			  }
			: null,
	})
})

app.post('/logout', async (c) => {
	const token = getCookie(c, 'session') ?? null

	if (token === null) {
		return c.json({ user: null })
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		return c.json({}, 401)
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	await invalidateSession(user.id)
	deleteSessionTokenCookie(c)

	return c.json({}, 200)
})

app.get('/login/google', (c) => {
	const redirect = c.req.query('redirect')

	const state = encodeURI(
		JSON.stringify({ key: generateState(), redirect: redirect }),
	)

	const codeVerifier = generateCodeVerifier()
	const url = google.createAuthorizationURL(state, codeVerifier, [
		'openid',
		'profile',
		'email',
	])

	setCookie(c, 'google_oauth_state', state, {
		path: '/',
		httpOnly: true,
		maxAge: 60 * 10, // 10 minutes
		sameSite: 'lax',
	})
	setCookie(c, 'google_code_verifier', codeVerifier, {
		path: '/',
		httpOnly: true,
		maxAge: 60 * 10, // 10 minutes
		sameSite: 'lax',
	})

	return c.redirect(url.toString(), 302)
})

app.get('/login/google/callback', async (c) => {
	const code = c.req.query('code')
	const state = c.req.query('state')
	const storedState = getCookie(c, 'google_oauth_state') ?? null
	const codeVerifier = getCookie(c, 'google_code_verifier') ?? null
	if (
		code === undefined ||
		state === undefined ||
		storedState === null ||
		codeVerifier === null
	) {
		return new Response(null, {
			status: 400,
		})
	}
	if (state !== storedState) {
		return new Response(null, {
			status: 400,
		})
	}

	let tokens: OAuth2Tokens
	try {
		tokens = await google.validateAuthorizationCode(
			code,
			codeVerifier,
		)
	} catch (e) {
		// Invalid code or client credentials
		return new Response(null, {
			status: 400,
		})
	}
	const claims = decodeIdToken(tokens.idToken())
	// @ts-ignore
	const googleUserId = claims.sub
	// @ts-ignore
	const username = claims.name
	// @ts-ignore
	const email = claims.email

	const existingUser = await db.query.user.findFirst({
		where: (user, { eq }) => eq(user.googleId, googleUserId),
	})

	const redirectUrl =
		(JSON.parse(decodeURI(state)).redirect as string | null) ||
		'/dashboard'

	if (existingUser) {
		const sessionToken = generateSessionToken()
		const session = await createSession(sessionToken, existingUser.id)
		setSessionTokenCookie(c, sessionToken, session.expiresAt)
		return c.redirect(redirectUrl, 302)
	}

	const createdUser = (
		await db
			.insert(user)
			.values({
				id: generateSessionToken(),
				googleId: googleUserId,
				username: username,
				email: email,
				plan: 'free',
				searchCredit: 0,
				premiumChatLimit: 0,
				premiumChatCredit: 0,
				searchLimit: 0,
				standardChatCredit: 0,
				standardChatLimit: 0,
				createdAt: Date.now(),
			})
			.returning()
	)[0]

	const sessionToken = generateSessionToken()
	const session = await createSession(sessionToken, createdUser.id)
	setSessionTokenCookie(c, sessionToken, session.expiresAt)

	return c.redirect(redirectUrl, 302)
})

export default app
