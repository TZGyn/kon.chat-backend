import { Hono } from 'hono'
import { Checkout, CustomerPortal } from '@polar-sh/hono'
import {
	convertToCoreMessages,
	createDataStreamResponse,
	generateId,
	generateObject,
	generateText,
	streamText,
	type CoreUserMessage,
	type UserContent,
} from 'ai'
import { getMostRecentUserMessage } from '../lib/utils'
import { google, openai } from '../lib/ai/model'
import { z } from 'zod'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import {
	getCookie,
	getSignedCookie,
	setCookie,
	setSignedCookie,
	deleteCookie,
} from 'hono/cookie'

// For extending the Zod schema with OpenAPI properties
import 'zod-openapi/extend'
import { resolver, validator as zValidator } from 'hono-openapi/zod'
import { describeRoute, openAPISpecs } from 'hono-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '../lib/auth/session'

import AuthRoutes from './routes/auth'
import { db } from '../lib/db'
import { chat, message, user } from '../lib/db/schema'
import {
	generateTitleFromUserMessage,
	sanitizeResponseMessages,
} from '../lib/ai/utils'
import { and, eq } from 'drizzle-orm'
import { jinaRead } from '../lib/ai/jina'
import { braveSearch } from '../lib/ai/brave'

const app = new Hono()
app.use(cors())
app.use(logger())

app.get('/', (c) => {
	return c.text('Hello Hono!')
})

app.get(
	'/openapi',
	openAPISpecs(app, {
		documentation: {
			info: {
				title: 'Hono',
				version: '1.0.0',
				description: 'API for greeting users',
			},
			servers: [
				{
					url: 'http://localhost:3000',
					description: 'Local server',
				},
			],
		},
	}),
)

app.get(
	'/docs',
	apiReference({
		theme: 'saturn',
		spec: {
			url: '/openapi',
		},
	}),
)

app.get(
	'/checkout',
	Checkout({
		accessToken: Bun.env.POLAR_ACCESS_KEY, // Or set an environment variable to POLAR_ACCESS_TOKEN
		successUrl: Bun.env.SUCCESS_URL,
		server:
			Bun.env.APP_ENV === 'production' ? 'production' : 'sandbox', // Use sandbox if you're testing Polar - omit the parameter or pass 'production' otherwise
	}),
)

app.get(
	'/portal',
	CustomerPortal({
		accessToken: 'xxx', // Or set an environment variable to POLAR_ACCESS_TOKEN
		getCustomerId: async (event) => {
			const token = getCookie(event, 'session') ?? null

			if (token === null) {
				return ''
			}
			const { session, user } = await validateSessionToken(token)

			if (!user) {
				return ''
			}

			if (session !== null) {
				setSessionTokenCookie(event, token, session.expiresAt)
			} else {
				deleteSessionTokenCookie(event)
			}

			return user.polarCustomerId || ''
		}, // Function to resolve a Polar Customer ID
		server: 'sandbox', // Use sandbox if you're testing Polar - omit the parameter or pass 'production' otherwise
	}),
)

app.route('/auth', AuthRoutes)

app.get('/chat', async (c) => {
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

app.get('/chat/:chat_id', async (c) => {
	const token = getCookie(c, 'session') ?? null
	const chatId = c.req.param('chat_id')

	if (token === null) return c.json({ chat: null })

	const { session, user } = await validateSessionToken(token)

	if (!user) return c.json({ chat: null })

	const chat = await db.query.chat.findFirst({
		where: (chat, { eq, and }) =>
			and(eq(chat.id, chatId), eq(chat.userId, user.id)),
		with: {
			messages: {
				orderBy: (message, { asc }) => [asc(message.createdAt)],
			},
		},
	})

	return c.json({ chat })
})

app.delete('/chat/:chat_id', async (c) => {
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

app.post(
	'/chat/:chat_id',
	describeRoute({
		description: 'Say hello to the user',
		responses: {
			200: {
				description: 'Successful greeting response',
				content: {
					'text/plain': {
						schema: resolver(
							z.string().openapi({ example: 'Hello Steven!' }),
						),
					},
				},
			},
		},
	}),
	zValidator(
		'json',
		z.object({
			messages: z.any(),
			provider: z
				.union([
					z.object({
						name: z.literal('openai'),
						model: z.enum(['gpt-4o', 'gpt-4o-mini', 'o3-mini']),
					}),
					z.object({
						name: z.literal('google'),
						model: z.enum(['gemini-2.0-flash-001']),
					}),
				])
				.default({ name: 'openai', model: 'gpt-4o-mini' }),
			search: z.boolean().default(false),
		}),
	),
	async (c) => {
		const { messages, provider, search } = c.req.valid('json')

		const token = getCookie(c, 'session') ?? null
		const chatId = c.req.param('chat_id')

		const coreMessages = convertToCoreMessages(messages)
		const userMessage = getMostRecentUserMessage(coreMessages)

		if (!userMessage) {
			return c.json({ success: false, message: 'No User Message' })
		}

		let model

		if (provider.name === 'openai') {
			model = openai(provider.model)
		} else if (provider.name === 'google') {
			model = google(provider.model)
		} else {
			return c.json({ success: false, message: 'Invalid Model' })
		}

		return createDataStreamResponse({
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
							You will be provided a prompt from a user
							You will build a single search query text that will be later be used to fulfill the info needed for that prompt
							Always assume your knowledge is out of date

							Example of incorrect searches:
							- prompt: who is the current us president
							- query: 2024 president
							This is wrong because you assume this year is 2024

							Rather a search query like this would be better
							- prompt: who won the most recent superbowl
							- query: latest superbowl result
							This is correct because the query doesnt assume any information but still contains the neccessary query data to fulfill the prompt

							Current year is ${new Date().getFullYear()}
						`,
							prompt: prompt,
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

						dataStream.writeData({
							type: 'message',
							message: 'Reading Articles',
						})

						jinaData = (
							await Promise.all(
								articles.map(async (article) => {
									return await jinaRead(article.url)
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
						Dont call any tools as there are no tools
						Only use the information provided to you
						If theres is a need for search, the search result will be provided to you

						if a math equation is generated, wrap it around $ for katex inline styling and $$ for block
						example:

						(inline) 
						Pythagorean theorem: $a^2+b^2=c^2$

						(block)
						$$
						\mathcal{L}\{f\}(s) = \int_0^{\infty} {f(t)e^{-st}dt}
						$$

						${searchMessage}
					`,
					onError: (error) => {
						console.log(error)
					},
					onChunk() {
						dataStream.writeMessageAnnotation({ chunk: '123' })
					},
					onFinish: async ({ response, usage }) => {
						if (token === null) return

						const { session, user } = await validateSessionToken(
							token,
						)

						if (!user) return

						const existingChat = await db.query.chat.findFirst({
							where: (chat, { eq, and }) =>
								and(eq(chat.id, chatId), eq(chat.userId, user.id)),
						})

						if (!existingChat) {
							const title = await generateTitleFromUserMessage({
								message: userMessage,
							})

							await db.insert(chat).values({
								id: chatId,
								title: title,
								userId: user.id,
								createdAt: Date.now(),
							})
						}

						await db.insert(message).values({
							...userMessage,
							id: generateId(),
							chatId: chatId,
							promptTokens: 0,
							completionTokens: 0,
							totalTokens: 0,
							createdAt: Date.now(),
						})

						const responseMessagesWithoutIncompleteToolCalls =
							sanitizeResponseMessages(response.messages)

						await db.insert(message).values(
							responseMessagesWithoutIncompleteToolCalls.map(
								(message, index) => {
									const messageId = generateId()

									return {
										id: messageId,
										chatId: chatId,
										role: message.role,
										content: message.content,
										model: provider.model,
										braveData: brave,
										jinaData: jina,
										...usage,
										createdAt: Date.now() + (index + 1) * 1,
									}
								},
							),
						)
					},
				})

				result.mergeIntoDataStream(dataStream)
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

Bun.serve({
	...app,
	idleTimeout: 255,
})
