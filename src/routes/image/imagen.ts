import { Hono } from 'hono'

import { createVertex } from '@ai-sdk/google-vertex'
import { experimental_generateImage as generateImage } from 'ai'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Limit } from '$lib/ratelimit'
import { redis } from '$lib/redis'
import { getCookie, setCookie } from 'hono/cookie'
import { encodeHexLowerCase } from '@oslojs/encoding'
import { sha256 } from '@oslojs/crypto/sha2'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '$lib/auth/session'

const app = new Hono()

const getGoogleLocation = (fly_region: string | undefined) => {
	return 'us-west1'
	switch (fly_region) {
		case 'iad':
			return 'us-west1'
		case 'sin':
			return 'asia-southeast1'
		default:
			return 'us-west1'
	}
}

app.post(
	'/generate',
	zValidator(
		'json',
		z.union([
			z.object({
				prompt: z.string(),
				negative_prompt: z.string(),
				model: z.enum([
					'imagen-3.0-generate-001',
					'imagen-3.0-fast-generate-001',
				]),
				count: z.number().max(4),
				aspect_ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']),
			}),
			z.object({
				prompt: z.string(),
				negative_prompt: z.string(),
				model: z.literal('imagen-3.0-generate-002'),
				count: z.number().max(4),
				aspect_ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']),
			}),
		]),
	),
	async (c) => {
		let token = getCookie(c, 'session') ?? null
		if (!token || token.startsWith('free:')) {
			return c.json({}, 401)
		}

		let limit = await redis.get<Limit>(
			encodeHexLowerCase(sha256(new TextEncoder().encode(token))) +
				'-limit',
		)

		if (!limit) {
			const { session, user } = await validateSessionToken(token)
			if (!user) return c.json({ error: 'Invalid User' }, 401)

			if (session !== null) {
				setSessionTokenCookie(c, session.id, session.expiresAt)
			} else {
				deleteSessionTokenCookie(c)
			}

			limit = {
				plan: user.plan,
				credits: user.credits,
				purchased_credits: user.purchasedCredits,
			}

			await redis.set(
				session.id + '-limit',
				{
					...limit,
				},
				{ ex: 60 * 60 * 24 },
			)
		}

		const { count, model, prompt, negative_prompt, aspect_ratio } =
			c.req.valid('json')
		// const region = Bun.env.FLY_REGION
		// const projectID = Bun.env.GEMINI_PROJECT_ID!

		// const location = getGoogleLocation(region)

		// const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectID}/locations/${location}/publishers/google/models/imagen-3.0-generate-002:predict`

		// const response = await fetch(url, {
		// 	method: 'POST',
		// 	headers: {
		// 		Authorization: 'Bearer ' + Bun.env.GEMINI_API_KEY!,
		// 		'Content-Type': 'application/json',
		// 	},
		// 	body: JSON.stringify({
		// 		instances: [
		// 			{
		// 				prompt: 'cute cartoon fox',
		// 			},
		// 		],
		// 		parameters: {
		// 			sampleCount: 8,
		// 		},
		// 	}),
		// })

		const credentials = {
			private_key:
				Bun.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
					/\\n/g,
					'\n',
				) ?? '',
			client_email: Bun.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
		}
		const vertex = createVertex({
			project: Bun.env.GEMINI_PROJECT_ID!, // optional
			location: getGoogleLocation(Bun.env.FLY_REGION),
			googleAuthOptions: {
				credentials,
			},
			// baseURL: undefined,
		})
		try {
			const result = await generateImage({
				model: vertex.image(model, {
					maxImagesPerCall: 4,
				}),
				prompt: prompt,
				aspectRatio: aspect_ratio,
				n: count,
				providerOptions: {
					vertex: { negativePrompt: negative_prompt },
				},
			})

			return c.json({ images: result.images })
		} catch (error) {
			return c.text('Unable to generate images')
		}
	},
)

export default app
