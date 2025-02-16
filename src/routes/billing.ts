import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '../../lib/auth/session'
import { Polar } from '@polar-sh/sdk'
import { db } from '../../lib/db'
import { user as userTable } from '../../lib/db/schema'
import { eq } from 'drizzle-orm'
import { Checkout } from '@polar-sh/hono'

const polar = new Polar({
	accessToken: Bun.env.POLAR_ACCESS_KEY,
	server: Bun.env.APP_ENV === 'production' ? 'production' : 'sandbox',
})

const app = new Hono()

app.get('/plan/basic', async (c) => {
	const token = getCookie(c, 'session') ?? null

	if (token === null || token.startsWith('free:')) {
		return c.redirect('/auth/login/google', 302)
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		return c.redirect('/auth/login/google', 302)
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	let polarCustomerId = user.polarCustomerId

	if (!polarCustomerId) {
		const result = await polar.customers.create({
			email: user.email,
		})

		await db
			.update(userTable)
			.set({
				polarCustomerId: result.id,
			})
			.where(eq(userTable.id, user.id))

		polarCustomerId = result.id
	}

	return c.redirect(
		`/billing/checkout?productPriceId=${Bun.env.POLAR_BASIC_PLAN_PRICE_ID}&customerId=${polarCustomerId}`,
		302,
	)
})

app.get(
	'/checkout',
	Checkout({
		accessToken: Bun.env.POLAR_ACCESS_KEY,
		successUrl: Bun.env.FRONTEND_URL + '/',
		server:
			Bun.env.APP_ENV === 'production' ? 'production' : 'sandbox',
	}),
)

export default app
