import { Tool } from '$lib/ai/tools'
import {
	freeModels,
	premiumModels,
	Provider,
	standardModels,
} from '$lib/model'

export const costTable: {
	[Key in
		| (typeof freeModels)[number]
		| (typeof standardModels)[number]
		| (typeof premiumModels)[number]
		| Tool]: number
} = {
	'gemini-2.0-flash-001': 0,
	'claude-3-5-sonnet-latest': 15,
	'claude-3-7-sonnet-20250219': 15,
	'deepseek-r1-distill-llama-70b': 2,
	'gpt-4o': 5,
	'gpt-4o-mini': 1,
	'grok-2-1212': 2,
	'grok-2-vision-1212': 2,
	'llama-3.3-70b-versatile': 1,
	'o3-mini': 2,
	'qwen-qwq-32b': 2,
	academic_search: 5,
	chat: 0,
	web_reader: 5,
	web_search: 5,
	x_search: 5,
} as const

export const calculateCost = ({
	provider,
	tool,
}: {
	provider: Provider
	tool: Tool
}) => {
	return costTable[provider.model] + costTable[tool]
}
