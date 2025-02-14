import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'

export const openai = createOpenAI({
	apiKey: Bun.env.OPENAI_API_KEY,
	compatibility: 'strict',
})

export const anthropic = createAnthropic({
	apiKey: Bun.env.CLAUDE_API_KEY,
})

export const google = createGoogleGenerativeAI({
	apiKey: Bun.env.GEMINI_API_KEY,
})

export const groq = createGroq({
	apiKey: Bun.env.GROQ_API_KEY,
})
