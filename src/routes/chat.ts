import {
	createDataStreamResponse,
	smoothStream,
	streamText,
} from 'ai'
import { z } from 'zod'
import { getCookie } from 'hono/cookie'

// For extending the Zod schema with OpenAPI properties
import 'zod-openapi/extend'
import { validator as zValidator } from 'hono-openapi/zod'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '$lib/auth/session'

import { db } from '$lib/db'
import { chat, message } from '$lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google'
import { redis } from '$lib/redis'
import { getModel, modelSchema } from '$lib/model'
import { processMessages } from '$lib/message'
import { checkRatelimit, Limit } from '$lib/ratelimit'
import { updateUserChatAndLimit } from '$lib/chat/utils'
import { serialize } from 'hono/utils/cookie'
import { activeTools, tools } from '$lib/ai/tools'

const app = new Hono()

app.get('/', async (c) => {
	const token = getCookie(c, 'session') ?? null

	if (token === null) {
		return c.json({ chats: [] })
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		return c.json({ chats: [] })
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	const chats = await db.query.chat.findMany({
		columns: {
			id: true,
			title: true,
		},
		where: (chat, { eq }) => eq(chat.userId, user.id),
		orderBy: (chat, { desc }) => [desc(chat.createdAt)],
	})

	return c.json({ chats })
})

app.get('/:chat_id', async (c) => {
	const token = getCookie(c, 'session') ?? null
	const chatId = c.req.param('chat_id')

	if (token === null) return c.json({ chat: null })

	const { session, user } = await validateSessionToken(token)

	if (!user) return c.json({ chat: null })

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	const chat = await db.query.chat.findFirst({
		where: (chat, { eq, and }) =>
			and(eq(chat.id, chatId), eq(chat.userId, user.id)),
		with: {
			messages: {
				columns: {
					content: true,
					role: true,
					model: true,
					id: true,
					createdAt: true,
					chatId: true,
					provider: true,
					providerMetadata: true,
				},
				orderBy: (message, { asc }) => [asc(message.createdAt)],
			},
		},
	})

	return c.json({ chat })
})

app.post(
	'/:chat_id',
	zValidator(
		'json',
		z.object({
			messages: z.any(),
			provider: modelSchema,
			searchGrounding: z.boolean().default(false),
			mode: z
				.union([
					z.literal('x_search'),
					z.literal('chat'),
					z.literal('web_search'),
					z.literal('academic_search'),
					z.literal('web_reader'),
				])
				.default('chat'),
		}),
	),
	async (c) => {
		const { messages, provider, searchGrounding, mode } =
			c.req.valid('json')

		const {
			error: ratelimitError,
			limit,
			token,
			cookie,
		} = await checkRatelimit({
			c,
			provider,
			mode,
		})

		if (ratelimitError !== undefined) {
			return c.text(ratelimitError, { status: 400 })
		}

		const chatId = c.req.param('chat_id')

		const {
			coreMessages,
			error: processMessageError,
			userMessage,
			userMessageDate,
		} = processMessages({ provider, messages })

		if (processMessageError !== undefined) {
			return c.text(processMessageError, { status: 400 })
		}

		if (limit.plan === 'free' || limit.plan === 'trial') {
			if (Array.isArray(userMessage.content)) {
				if (
					userMessage.content.some((content) => {
						return content.type !== 'text'
					})
				) {
					return c.text('No image upload allowed for free plan', {
						status: 400,
					})
				}
			}
		}

		const { model, error, providerOptions } = getModel({
			provider,
			searchGrounding,
			token,
		})

		if (error !== null) {
			return c.text(error, 400)
		}

		let headers = {}
		if (cookie === 'delete') {
			headers = {
				'Set-Cookie': serialize('session', '', {
					httpOnly: true,
					path: '/',
					secure: Bun.env.APP_ENV === 'production',
					sameSite: 'lax',
					expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
				}),
			}
		} else if (cookie === 'set') {
			headers = {
				'Set-Cookie': serialize('session', token, {
					httpOnly: true,
					path: '/',
					secure: Bun.env.APP_ENV === 'production',
					sameSite: 'lax',
					expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
				}),
			}
		}

		return createDataStreamResponse({
			headers: {
				...c.res.headers,
				...headers,
			},
			execute: async (dataStream) => {
				dataStream.writeMessageAnnotation({
					type: 'model',
					model: provider.model,
				})

				dataStream.writeData({
					type: 'message',
					message: 'Understanding prompt',
				})

				dataStream.writeData({
					type: 'message',
					message: 'Generating Response',
				})

				const additionalSystemPrompt = {
					chat: `You are not given a web search ability, if user ask you to do so, let the user know there is ability is limit`,
					x_search: `
						You have been given an ability to search X(formerly Twitter)'s posts
						'You MUST run the tool first exactly once' before composing your response. **This is non-negotiable.**
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					web_search: `
						You have been given a web search ability, 
						'You MUST run the tool first exactly once' before composing your response. **This is non-negotiable.**
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					academic_search: `
						You have been given an ability to search academic papers
						'You MUST run the tool first exactly once' before composing your response. **This is non-negotiable.**
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					web_reader: `
						You have been given an ability to fetch url as markdown 
						'You MUST run the tool first exactly once' before composing your response. **This is non-negotiable.**
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
				}

				const result = streamText({
					model: model,
					messages: coreMessages,
					system: `
						You are a chat assistant ${
							searchGrounding && 'with search grounding ability'
						}

						Today's Date: ${new Date().toLocaleDateString('en-US', {
							year: 'numeric',
							month: 'short',
							day: '2-digit',
							weekday: 'short',
						})}

						Note: frontend has a tool to display mermaid code, 
						so you don't have to tell the user you don't have the ability to render mermaid code 
						or tell the user how to render them

						if a math equation is generated, wrap it around $$ for katex inline styling and $$ for block
						example:

						(inline)
						Pythagorean theorem: $$a^2+b^2=c^2$$

						(block)
						$$
						\mathcal{L}\{f\}(s) = \int_0^{\infty} {f(t)e^{-st}dt}
						$$

						DONT USE $$ UNLESS YOU NEED TO GENERATE MATH FORMULAS

						WRAP CODE AROUND \`IF INLINE\`
						WRAP CODE AROUND
						\`\`\`
						IF BLOCK
						\`\`\`

						Do not generate tool call details to the user

						${additionalSystemPrompt[mode]}
					`,
					providerOptions: providerOptions,
					abortSignal: c.req.raw.signal,
					onChunk: ({ chunk }) => {},
					maxSteps: 5,
					// experimental_activeTools: [...activeTools(mode)],
					tools: {
						...tools(dataStream, mode),
					},
					onStepFinish: (data) => {
						const metadata = data.providerMetadata?.google as
							| GoogleGenerativeAIProviderMetadata
							| undefined
						if (metadata) {
							// @ts-ignore
							dataStream.writeMessageAnnotation({
								type: 'google-grounding',
								data: metadata,
							})
						}
						// console.log(
						// 	require('util').inspect(
						// 		data,
						// 		false,
						// 		null,
						// 		true /* enable colors */,
						// 	),
						// )
					},
					onError: (error) => {
						console.log('Error', error)
					},
					experimental_transform: smoothStream({
						delayInMs: 20, // optional: defaults to 10ms
						chunking: 'word', // optional: defaults to 'word'
					}),
					onFinish: async ({
						response,
						usage,
						reasoning,
						providerMetadata,
						finishReason,
					}) => {
						updateUserChatAndLimit({
							chatId,
							messages: response.messages,
							provider,
							providerMetadata,
							reasoning,
							token,
							usage,
							userMessage,
							userMessageDate,
							mode,
						})
					},
				})

				result.mergeIntoDataStream(dataStream, {
					sendReasoning: true,
				})
			},
			onError: (error) => {
				// Error messages are masked by default for security reasons.
				// If you want to expose the error message to the client, you can do so here:
				console.log('Stream Error', error)
				return error instanceof Error ? error.message : String(error)
			},
		})
	},
)

app.delete('/:chat_id', async (c) => {
	const token = getCookie(c, 'session') ?? null
	const chatId = c.req.param('chat_id')

	if (token === null) return c.json({ success: false })

	const { session, user } = await validateSessionToken(token)

	if (!user) return c.json({ success: false })

	const existingChat = await db.query.chat.findFirst({
		where: (chat, { eq, and }) =>
			and(eq(chat.id, chatId), eq(chat.userId, user.id)),
		with: {
			messages: true,
		},
	})

	if (!existingChat) return c.json({ success: false })

	await db
		.delete(chat)
		.where(and(eq(chat.id, chatId), eq(chat.userId, user.id)))

	await db.delete(message).where(eq(message.chatId, chatId))

	return c.json({ success: true })
})

export default app
