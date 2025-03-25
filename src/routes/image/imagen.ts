import { Hono } from 'hono'

import { createVertex } from '@ai-sdk/google-vertex'
import { experimental_generateImage as generateImage } from 'ai'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

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
	},
)

export default app
