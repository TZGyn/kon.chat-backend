import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '$lib/auth/session'
import { nanoid } from '$lib/utils'
import { s3Client } from '$lib/s3'

const app = new Hono()

app.post(
	'/',
	zValidator(
		'form',
		z.object({
			file: z
				.instanceof(File)
				.refine((file) => file.size <= 5 * 1024 * 1024, {
					message: 'File size should be less than 5MB',
				})
				// Update the file type based on the kind of files you want to accept
				.refine(
					(file) =>
						[
							'image/jpeg',
							'image/png',
							'application/pdf',
							// 'text/csv',
							// 'text/plain',
						].includes(file.type),
					{
						message: 'File type not supported',
					},
				),
		}),
	),
	async (c) => {
		const token = getCookie(c, 'session') ?? null

		if (token === null) {
			return c.json({ link: '' }, 401)
		}

		const { session, user } = await validateSessionToken(token)

		if (!user) {
			return c.json({ link: '' }, 401)
		}

		if (session !== null) {
			setSessionTokenCookie(c, token, session.expiresAt)
		} else {
			deleteSessionTokenCookie(c)
		}

		const file = c.req.valid('form').file

		const id = `${user.id}/${nanoid()}-${file.name}`
		const s3file = s3Client.file(id)

		await s3file.write(file)

		return c.json({ link: Bun.env.S3_PUBLIC_URL + '/' + id })
	},
)

export default app
