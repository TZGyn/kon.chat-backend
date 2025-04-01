import { z } from 'zod'
import {
	anthropic,
	google,
	groq,
	openai,
	vertex,
	xai,
} from '$lib/ai/model'
import {
	extractReasoningMiddleware,
	LanguageModelV1,
	wrapLanguageModel,
} from 'ai'

export const modelSchema = z
	.union([
		z.object({
			name: z.literal('openai'),
			model: z.enum(['gpt-4o', 'gpt-4o-mini', 'o3-mini']),
		}),
		z.object({
			name: z.literal('google'),
			model: z.enum([
				'gemini-2.0-flash-001',
				'gemini-2.5-pro-exp-03-25',
			]),
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

const getContextSize = (provider: Provider) => {
	if (provider.model === 'gemini-2.0-flash-001') return 1_000_000
	if (
		provider.model === 'o3-mini' ||
		provider.model === 'claude-3-5-sonnet-latest' ||
		provider.model === 'claude-3-7-sonnet-20250219'
	)
		return 300_000
	return 128_000
}

export type Provider = z.infer<typeof modelSchema>

export const freeModels = [
	'gemini-2.0-flash-001',
	'gemini-2.5-pro-exp-03-25',
] as const

export const standardModels = [
	'gpt-4o',
	'gpt-4o-mini',
	'o3-mini',
	'deepseek-r1-distill-llama-70b',
	'llama-3.3-70b-versatile',
	'grok-2-1212',
	'grok-2-vision-1212',
	'qwen-qwq-32b',
] as const

export const premiumModels = [
	'claude-3-5-sonnet-latest',
	'claude-3-7-sonnet-20250219',
] as const

export const getModel = ({
	provider,
	searchGrounding,
	token,
}: {
	provider: Provider
	searchGrounding: boolean
	token: string
}):
	| {
			model: LanguageModelV1
			providerOptions: Record<any, any> | undefined
			contextSize: number
			error: null
	  }
	| { model: null; providerOptions: null; error: string } => {
	let model
	let providerOptions = {}

	if (provider.name === 'google') {
		model = google(provider.model, {
			useSearchGrounding: searchGrounding,
		})
	} else if (provider.name === 'openai') {
		model = openai(provider.model)
		if (provider.model === 'o3-mini') {
			providerOptions = {
				openai: { reasoningEffort: 'high' },
			}
		}
	} else if (provider.name === 'groq') {
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
		model = anthropic(provider.model)
		if (provider.model === 'claude-3-7-sonnet-20250219') {
			providerOptions = {
				anthropic: {
					thinking: { type: 'enabled', budgetTokens: 12000 },
				},
			}
		}
	} else if (provider.name === 'xai') {
		model = xai(provider.model)
	} else {
		return {
			error: 'Invalid Model',
			model: null,
			providerOptions: null,
		}
	}

	return {
		model,
		providerOptions,
		error: null,
		contextSize: getContextSize(provider),
	}
}
