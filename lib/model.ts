import { z } from 'zod'
import { anthropic, google, groq, openai, xai } from '$lib/ai/model'
import {
	extractReasoningMiddleware,
	LanguageModelV1,
	wrapLanguageModel,
} from 'ai'
import { Limit } from '$lib/ratelimit'

export const modelSchema = z
	.union([
		z.object({
			name: z.literal('openai'),
			model: z.enum(['gpt-4o', 'gpt-4o-mini', 'o3-mini']),
		}),
		z.object({
			name: z.literal('google'),
			model: z.enum(['gemini-2.0-flash-001']),
		}),
		z.object({
			name: z.literal('groq'),
			model: z.enum([
				'deepseek-r1-distill-llama-70b',
				'llama-3.3-70b-versatile',
				'qwen-qwq-32b',
			]),
		}),
		z.object({
			name: z.literal('anthropic'),
			model: z.enum([
				'claude-3-5-sonnet-latest',
				'claude-3-7-sonnet-20250219',
			]),
		}),
		z.object({
			name: z.literal('xai'),
			model: z.enum(['grok-2-1212', 'grok-2-vision-1212']),
		}),
	])
	.default({ name: 'google', model: 'gemini-2.0-flash-001' })

export type Provider = z.infer<typeof modelSchema>

export const freeModels = ['gemini-2.0-flash-001']

export const standardModels = [
	'gpt-4o',
	'gpt-4o-mini',
	'o3-mini',
	'deepseek-r1-distill-llama-70b',
	'llama-3.3-70b-versatile',
	'grok-2-1212',
	'grok-2-vision-1212',
]

export const premiumModels = [
	'claude-3-5-sonnet-latest',
	'claude-3-7-sonnet-20250219',
]

export const getModel = ({
	provider,
	searchGrounding,
	token,
	limit,
}: {
	provider: z.infer<typeof modelSchema>
	searchGrounding: boolean
	token: string
	limit: Limit
}):
	| {
			model: LanguageModelV1
			providerOptions: Record<any, any> | undefined
			error: null
	  }
	| { model: null; providerOptions: null; error: string } => {
	let model
	let providerOptions = {}
	if (provider.name === 'openai') {
		if (!token) {
			return {
				error: 'You have to be logged in to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.plan === 'free' || limit.plan === 'trial') {
			return {
				error:
					'You need to have basic or higher plan to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.standardLimit + limit.standardCredit <= 0) {
			return {
				error: 'You have reached the limit',
				model: null,
				providerOptions: null,
			}
		}

		model = openai(provider.model)
		if (provider.model === 'o3-mini') {
			providerOptions = {
				openai: { reasoningEffort: 'high' },
			}
		}
	} else if (provider.name === 'google') {
		if (limit.plan === 'trial' && limit.freeLimit <= 0) {
			return {
				error: 'You have reached the limit',
				model: null,
				providerOptions: null,
			}
		}
		model = google(provider.model, {
			useSearchGrounding: searchGrounding,
		})
	} else if (provider.name === 'groq') {
		if (!token) {
			return {
				error: 'You have to be logged in to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.plan === 'free' || limit.plan === 'trial') {
			return {
				error:
					'You need to have basic or higher plan to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.standardLimit + limit.standardCredit <= 0) {
			return {
				error: 'You have reached the limit',
				model: null,
				providerOptions: null,
			}
		}

		if (provider.model !== 'llama-3.3-70b-versatile') {
			model = wrapLanguageModel({
				model: groq(provider.model),
				middleware: extractReasoningMiddleware({
					tagName: 'think',
				}),
			})
		} else {
			model = groq(provider.model)
		}
	} else if (provider.name === 'anthropic') {
		if (!token) {
			return {
				error: 'You have to be logged in to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.plan !== 'pro') {
			return {
				error: 'You need to have pro plan to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.premiumCredit + limit.premiumLimit <= 0) {
			return {
				error: 'You have reached the limit',
				model: null,
				providerOptions: null,
			}
		}
		model = anthropic(provider.model)
		if (provider.model === 'claude-3-7-sonnet-20250219') {
			providerOptions = {
				anthropic: {
					thinking: { type: 'enabled', budgetTokens: 12000 },
				},
			}
		}
	} else if (provider.name === 'xai') {
		if (!token) {
			return {
				error: 'You have to be logged in to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.plan === 'free' || limit.plan === 'trial') {
			return {
				error:
					'You need to have basic or higher plan to use this model',
				model: null,
				providerOptions: null,
			}
		}

		if (limit.standardLimit + limit.standardCredit <= 0) {
			return {
				error: 'You have reached the limit',
				model: null,
				providerOptions: null,
			}
		}

		model = xai(provider.model)
	} else {
		return {
			error: 'Invalid Model',
			model: null,
			providerOptions: null,
		}
	}

	return { model, providerOptions, error: null }
}
