import {
	appendResponseMessages,
	convertToCoreMessages,
	createDataStream,
	createDataStreamResponse,
	extractReasoningMiddleware,
	generateId,
	generateText,
	smoothStream,
	streamText,
	tool,
	wrapLanguageModel,
	type CoreUserMessage,
	type UserContent,
} from 'ai'
import { getMostRecentUserMessage, nanoid } from '$lib/utils'
import { anthropic, google, groq, openai } from '$lib/ai/model'
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
import { chat, message, user } from '$lib/db/schema'
import {
	generateTitleFromUserMessage,
	sanitizeResponseMessages,
} from '$lib/ai/utils'
import { and, eq, sql } from 'drizzle-orm'
import { jinaRead } from '$lib/ai/jina'
import { braveSearch } from '$lib/ai/brave'
import { Hono } from 'hono'
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google'
import { stream } from 'hono/streaming'
import { encodeHexLowerCase } from '@oslojs/encoding'
import { sha256 } from '@oslojs/crypto/sha2'
import { redis } from '$lib/redis'
import { getModel, modelSchema } from '$lib/model'
import { processMessages } from '$lib/message'
import {
	checkRatelimit,
	Limit,
	updateUserRatelimit,
} from '$lib/ratelimit'
import { updateUserChatAndLimit } from '$lib/chat/utils'
import { exa } from '$lib/ai/exa'
import { serialize } from 'hono/utils/cookie'
import { activeTools, tools } from '$lib/ai/tools'
function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

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
	await sleep(2000)
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
					braveData: true,
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
			search: z.boolean().default(false),
			searchGrounding: z.boolean().default(false),
			mode: z
				.union([
					z.literal('x_search'),
					z.literal('chat'),
					z.literal('web_search'),
				])
				.default('chat'),
		}),
	),
	async (c) => {
		const { messages, provider, search, searchGrounding, mode } =
			c.req.valid('json')

		const {
			error: ratelimitError,
			limit,
			token,
			cookie,
		} = await checkRatelimit({
			c,
			search,
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
			limit,
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

				let jinaData
				let braveSearchData
				if (search) {
					dataStream.writeData({
						type: 'error',
						message: 'Search is not allowed',
					})

					const prompt = userMessage.content

					if (typeof prompt === 'string') {
						const { text: query } = await generateText({
							model: google('gemini-2.0-flash-001'),
							system: `
								You are a search query generator
								You will be provided a prompt from a user and their recent messages with a chatbot
								You will build a single search query text that will be later be used to fulfill the info needed for that prompt
								For example:
								- A user is having a conversation about a certain person with the chatbot
								- When the user ask to help find the person's information
								- The user will not always type out the specify prompt like (help me find x person's facebook profile)
								- They might type something like (help me find his/her profile)

								So you must evaluate the previous messages and understand the context to generate the search query

								Always assume your knowledge is out of date

								Example of incorrect searches:
								- prompt: who is the current us president
								- query: 2024 president
								This is wrong because you assume this year is 2024

								Rather a search query like this would be better
								- prompt: who won the most recent superbowl
								- query: latest superbowl result
								This is correct because the query doesnt assume any information but still contains the neccessary query data to fulfill the prompt
								
								Current date is ${new Date().toString()}
							`,
							messages: coreMessages,
						})

						dataStream.writeData({
							type: 'message',
							message: 'Searching Internet',
						})

						const braveData = await braveSearch(query)

						braveSearchData = braveData

						const articles =
							braveData?.web.results.map((result) => {
								return {
									url: result.url,
									description: result.description,
									title: result.title,
									pageAge: result.page_age,
								}
							}) || []

						dataStream.writeMessageAnnotation({
							type: 'search',
							data: [...articles],
						})

						// dataStream.writeData({
						// 	type: 'message',
						// 	message: 'Filtering Articles',
						// })

						// const { object } = await generateObject({
						// 	model: openai('gpt-4o-mini'),
						// 	schema: z.object({
						// 		articles: z.array(
						// 			z.object({
						// 				url: z
						// 					.string()
						// 					.describe('url of the selected article'),
						// 				description: z
						// 					.string()
						// 					.describe(
						// 						'description of the selected article',
						// 					),
						// 				title: z
						// 					.string()
						// 					.describe('title of the selected article'),
						// 				pageAge: z
						// 					.string()
						// 					.describe('pageAge of the selected article'),
						// 			}),
						// 		),
						// 	}),
						// 	system: `
						// 		You are an article selector
						// 		You will be given a array of articles in json format
						// 		You will filtering the articles based on the relevance given a prompt
						// 		The each article given to you will have the following fields
						// 		- url (the url of the article)
						// 		- description (the description of the article)
						// 		- title (the title of the article)
						// 		- pageAge (the date of the article ex: 2025-01-21T09:15:03)

						// 		Here is the articles:
						// 		${JSON.stringify(articles)}
						// 	`,
						// 	prompt: prompt,
						// })

						let articlesReadCount = 0

						dataStream.writeData({
							type: 'message',
							message: `Reading Articles [${articlesReadCount}/10]`,
						})

						jinaData = (
							await Promise.all(
								articles.map(async (article) => {
									const data = await jinaRead(article.url)
									articlesReadCount++
									dataStream.writeData({
										type: 'message',
										message: `Reading Articles [${articlesReadCount}/10]`,
									})
									return data
								}),
							)
						).filter((data) => data !== undefined)
					} else {
						dataStream.writeData({
							type: 'error',
							message: 'Non-text search is not allowed',
						})
					}
				}

				dataStream.writeData({
					type: 'message',
					message: 'Generating Response',
				})

				let searchMessage
				if (jinaData === undefined) {
					searchMessage = ''
				} else {
					searchMessage = `
						User has also requested for a search function
						You will be provided the web search data that was found
						Use them to answer the user prompt
						data:
						${JSON.stringify(jinaData.map((data) => data.data))}
					`
				}

				const jina = jinaData

				const brave = braveSearchData

				const result = streamText({
					model: model,
					messages: coreMessages,
					system: `
						You are a chat assistant
						${
							!searchGrounding &&
							`
								Dont call any tools as there are no tools
								Only use the information provided to you
								If theres is a need for search, the search result will be provided to you
							`
						}

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

						You have the ability to search for X (formerly Twitter)'s posts

						ALWAYS CHECK YOUR AVAILABLE TOOLS, DO NOT ASSUME IT USING PREVIOUS MESSAGES

						When user ask for actions that you cannot perform:
						- make sure to let the user know when there is not tools to call, but make sure not to say this feature is unavailable
						- inform the user that is may be unavailable or they may have reached the limit

						${searchMessage}
					`,
					providerOptions: providerOptions,
					onChunk: ({ chunk }) => {},
					maxSteps: 5,
					experimental_activeTools: [...activeTools(mode)],
					tools: {
						...tools(dataStream),
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
						console.log(error)
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
					}) => {
						if (token.startsWith('free:')) {
							redis.set<Limit>(
								token + '-limit',
								{
									...limit,
									freeLimit: limit.freeLimit - 1,
								},
								{ ex: 60 * 60 * 24 },
							)
							return
						}

						updateUserChatAndLimit({
							brave,
							chatId,
							jina,
							messages: response.messages,
							provider,
							providerMetadata,
							reasoning,
							search,
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
				console.log(error)
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
