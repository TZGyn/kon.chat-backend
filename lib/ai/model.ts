import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createXai } from '@ai-sdk/xai'
import { GoogleAuth, GoogleAuthOptions } from 'google-auth-library'
import { createVertex } from '@ai-sdk/google-vertex'

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

export const xai = createXai({
	apiKey: Bun.env.XAI_API_KEY,
})

let authInstance: GoogleAuth | null = null
let authOptions: GoogleAuthOptions | null = null

function getAuth(options: GoogleAuthOptions) {
	if (!authInstance || options !== authOptions) {
		authInstance = new GoogleAuth({
			scopes: ['https://www.googleapis.com/auth/cloud-platform'],
			...options,
		})
		authOptions = options
	}
	return authInstance
}

export async function generateAuthToken(options?: GoogleAuthOptions) {
	const auth = getAuth(options || {})
	const client = await auth.getClient()
	const token = await client.getAccessToken()
	return token?.token || null
}

export const vertex = createVertex({
	project: Bun.env.GEMINI_PROJECT_ID!, // optional
	location: 'us-west1',
	googleAuthOptions: {
		credentials: {
			private_key:
				Bun.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
					/\\n/g,
					'\n',
				) ?? '',
			client_email: Bun.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
		},
	},
	// baseURL: undefined,
})
