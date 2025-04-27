import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '$lib/auth/session'
import { db } from '$lib/db'
import { user } from '$lib/db/schema'
import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'

const app = new Hono()

app.post(
	'/settings',
	zValidator(
		'json',
		z.object({
			name: z.string().max(50),
			additional_system_prompt: z.string().max(1000),
		}),
	),
	async (c) => {
		const token = getCookie(c, 'session') ?? null

		if (token === null) {
			return c.json({ success: false })
		}

		const { session, user: loggedInUser } =
			await validateSessionToken(token)

		if (!loggedInUser) {
			return c.json({ success: false })
		}

		if (session !== null) {
			setSessionTokenCookie(c, token, session.expiresAt)
		} else {
			deleteSessionTokenCookie(c)
		}

		const { additional_system_prompt, name } = c.req.valid('json')

		await db
			.update(user)
			.set({
				nameForLLM: name,
				additionalSystemPrompt: additional_system_prompt,
			})
			.where(eq(user.id, loggedInUser.id))

		return c.json({ success: true })
	},
)

export default app
