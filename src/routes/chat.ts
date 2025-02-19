import {
	convertToCoreMessages,
	createDataStream,
	createDataStreamResponse,
	extractReasoningMiddleware,
	generateId,
	generateText,
	smoothStream,
	streamText,
	wrapLanguageModel,
	type CoreUserMessage,
	type UserContent,
} from 'ai'
import { getMostRecentUserMessage } from '../../lib/utils'
import { anthropic, google, groq, openai } from '../../lib/ai/model'
import { z } from 'zod'
import { getCookie } from 'hono/cookie'

// For extending the Zod schema with OpenAPI properties
import 'zod-openapi/extend'
import { validator as zValidator } from 'hono-openapi/zod'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '../../lib/auth/session'

import { db } from '../../lib/db'
import { chat, message, user } from '../../lib/db/schema'
import {
	generateTitleFromUserMessage,
	sanitizeResponseMessages,
} from '../../lib/ai/utils'
import { and, eq, sql } from 'drizzle-orm'
import { jinaRead } from '../../lib/ai/jina'
import { braveSearch } from '../../lib/ai/brave'
import { Hono } from 'hono'
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google'
import { stream } from 'hono/streaming'
import { encodeHexLowerCase } from '@oslojs/encoding'
import { sha256 } from '@oslojs/crypto/sha2'
import { redis } from '../../lib/redis'

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
					z.object({
						name: z.literal('groq'),
						model: z.enum([
							'deepseek-r1-distill-llama-70b',
							'llama-3.3-70b-versatile',
						]),
					}),
					z.object({
						name: z.literal('anthropic'),
						model: z.enum(['claude-3-5-sonnet-latest']),
					}),
				])
				.default({ name: 'google', model: 'gemini-2.0-flash-001' }),
			search: z.boolean().default(false),
			searchGrounding: z.boolean().default(false),
		}),
	),
	async (c) => {
		const { messages, provider, search, searchGrounding } =
			c.req.valid('json')

		let token = getCookie(c, 'session') ?? null
		if (!token) {
			token = `free:${generateId()}`
			setSessionTokenCookie(
				c,
				token,
				Date.now() + 1000 * 60 * 60 * 24 * 1,
			)
			await redis.set(
				token + '-limit',
				{
					plan: 'free',
					standardLimit: 10,
					premiumLimit: 0,
					standardCredit: 0,
					premiumCredit: 0,
					searchLimit: 0,
					searchCredit: 0,
				},
				{ ex: 60 * 60 * 24 },
			)
		}

		let limit = await redis.get<{
			plan: 'free' | 'basic' | 'pro' | 'owner'
			standardLimit: number
			premiumLimit: number
			standardCredit: number
			premiumCredit: number
			searchLimit: number
			searchCredit: number
		}>(
			(token.startsWith('free:')
				? token
				: encodeHexLowerCase(
						sha256(new TextEncoder().encode(token)),
				  )) + '-limit',
		)

		if (!limit) {
			if (token.startsWith('free:')) {
				return c.text('You have been rate limited', { status: 400 })
			} else {
				const { session, user } = await validateSessionToken(token)
				if (!user) return c.text('Invalid User', { status: 400 })

				if (session !== null) {
					setSessionTokenCookie(c, token, session.expiresAt)
				} else {
					deleteSessionTokenCookie(c)
				}

				limit = {
					plan: user.plan,
					standardCredit: user.standardChatCredit,
					premiumCredit: user.premiumChatCredit,
					premiumLimit: user.premiumChatLimit,
					standardLimit: user.standardChatLimit,
					searchCredit: user.searchCredit,
					searchLimit: user.searchLimit,
				}
			}
		}

		if (search && limit.searchCredit + limit.searchLimit <= 0) {
			return c.text('You have reached the limit for web search', {
				status: 400,
			})
		}

		const chatId = c.req.param('chat_id')

		let coreMessages = convertToCoreMessages(messages)
		const userMessage = getMostRecentUserMessage(coreMessages)
		const userMessageDate = Date.now()

		if (provider.name === 'groq') {
			coreMessages = coreMessages.map((message) => {
				if (message.role === 'user') {
					if (Array.isArray(message.content)) {
						return {
							...message,
							content: message.content.filter((content) => {
								if (content.type === 'text') return true
								return false
							}),
						}
					} else {
						return message
					}
				}
				return message
			})
		}

		if (!userMessage) {
			return c.text('No User Message', { status: 400 })
		}

		if (limit.plan === 'free') {
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

		let model

		if (provider.name === 'openai') {
			if (!token) {
				return c.text('You have to be logged in to use this model', {
					status: 400,
				})
			}

			if (limit.plan === 'free') {
				return c.text(
					'You need to have basic or higher plan to use this model',
					{
						status: 400,
					},
				)
			}

			if (limit.standardLimit + limit.standardCredit <= 0) {
				return c.text('You have reached the limit', {
					status: 400,
				})
			}

			model = openai(provider.model)
		} else if (provider.name === 'google') {
			if (limit.standardLimit + limit.standardCredit <= 0) {
				return c.text('You have reached the limit', {
					status: 400,
				})
			}
			model = google(provider.model, {
				useSearchGrounding: searchGrounding,
			})
		} else if (provider.name === 'groq') {
			if (!token) {
				return c.text('You have to be logged in to use this model', {
					status: 400,
				})
			}

			if (limit.plan === 'free') {
				return c.text(
					'You need to have basic or higher plan to use this model',
					{
						status: 400,
					},
				)
			}

			if (limit.standardLimit + limit.standardCredit <= 0) {
				return c.text('You have reached the limit', {
					status: 400,
				})
			}

			if (provider.model === 'deepseek-r1-distill-llama-70b') {
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
				return c.text('You have to be logged in to use this model', {
					status: 400,
				})
			}

			if (limit.plan !== 'pro') {
				return c.text('You need to have pro plan to use this model', {
					status: 400,
				})
			}

			if (limit.premiumCredit + limit.premiumLimit <= 0) {
				return c.text('You have reached the limit', {
					status: 400,
				})
			}
			model = anthropic(provider.model)
		} else {
			return c.text('Invalid Model', { status: 400 })
		}

		return stream(c, (stream) =>
			stream.pipe(
				createDataStream({
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
							onChunk: ({ chunk }) => {},
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
								delayInMs: 10, // optional: defaults to 10ms
								chunking: 'word', // optional: defaults to 'word'
							}),
							onFinish: async ({
								response,
								usage,
								reasoning,
								providerMetadata,
							}) => {
								if (token.startsWith('free:')) {
									await redis.set(
										token + '-limit',
										{
											...limit,
											standardLimit: limit.standardLimit - 1,
										},
										{ ex: 60 * 60 * 24 },
									)
									return
								}

								const { session, user: loggedInUser } =
									await validateSessionToken(token)

								const standardModels = [
									'gpt-4o',
									'gpt-4o-mini',
									'o3-mini',
									'gemini-2.0-flash-001',
									'deepseek-r1-distill-llama-70b',
									'llama-3.3-70b-versatile',
								]

								const premiumModels = ['claude-3-5-sonnet-latest']

								if (!loggedInUser) return

								const existingChat = await db.query.chat.findFirst({
									where: (chat, { eq, and }) =>
										and(
											eq(chat.id, chatId),
											eq(chat.userId, loggedInUser.id),
										),
								})

								if (!existingChat) {
									const title = await generateTitleFromUserMessage({
										message: userMessage,
									})

									await db.insert(chat).values({
										id: chatId,
										title: title,
										userId: loggedInUser.id,
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
									createdAt: userMessageDate,
								})

								const responseMessagesWithoutIncompleteToolCalls =
									sanitizeResponseMessages({
										messages: response.messages,
										reasoning,
									})

								const now = Date.now()

								await db.insert(message).values(
									responseMessagesWithoutIncompleteToolCalls.map(
										(message, index) => {
											const messageId = generateId()
											const date = now + index

											return {
												id: messageId,
												chatId: chatId,
												role: message.role,
												content: message.content,
												model: provider.model,
												provider: provider.name,
												providerMetadata:
													message.role === 'assistant'
														? providerMetadata
														: undefined,
												braveData: brave,
												jinaData: jina,
												...usage,
												createdAt: date,
											}
										},
									),
								)

								const minusSearchLimit =
									loggedInUser.searchLimit > 0 && search
								const minusSearchCredit =
									!minusSearchLimit &&
									loggedInUser.searchCredit > 0 &&
									search

								const minusStandardLimit =
									loggedInUser.standardChatLimit > 0 &&
									standardModels.includes(provider.model)
								const minusStandardCredit =
									!minusStandardLimit &&
									loggedInUser.standardChatCredit > 0 &&
									standardModels.includes(provider.model)

								const minusPremiumLimit =
									loggedInUser.premiumChatLimit > 0 &&
									premiumModels.includes(provider.model)
								const minusPremiumCredit =
									!minusPremiumLimit &&
									loggedInUser.premiumChatCredit > 0 &&
									premiumModels.includes(provider.model)

								const [updatedUser] = await db
									.update(user)
									.set({
										searchLimit: sql`${user.searchLimit} - ${
											minusSearchLimit ? '1' : '0'
										}`,
										searchCredit: sql`${user.searchCredit} - ${
											minusSearchCredit ? '1' : '0'
										}`,
										standardChatLimit: sql`${
											user.standardChatLimit
										} - ${minusStandardLimit ? '1' : '0'}`,
										standardChatCredit: sql`${
											user.standardChatCredit
										} - ${minusStandardCredit ? '1' : '0'}`,
										premiumChatLimit: sql`${
											user.premiumChatLimit
										} - ${minusPremiumLimit ? '1' : '0'}`,
										premiumChatCredit: sql`${
											user.premiumChatCredit
										} - ${minusPremiumCredit ? '1' : '0'}`,
									})
									.where(eq(user.id, loggedInUser.id))
									.returning()

								const currentUser = await db.query.user.findFirst({
									where: (user, { eq }) =>
										eq(user.id, loggedInUser.id),
									with: {
										sessions: {
											where: (session, { gte }) =>
												gte(session.expiresAt, Date.now()),
										},
									},
								})

								if (!currentUser) return

								await Promise.all(
									currentUser.sessions.map(async (session) => {
										await redis.set(
											session.id + '-limit',
											{
												plan: updatedUser.plan,
												standardLimit: updatedUser.standardChatLimit,
												premiumLimit: updatedUser.premiumChatLimit,
												standardCredit:
													updatedUser.standardChatCredit,
												premiumCredit: updatedUser.premiumChatCredit,
												searchLimit: updatedUser.searchLimit,
												searchCredit: updatedUser.searchCredit,
											},
											{ ex: 60 * 60 * 24 },
										)
									}),
								)
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
						return error instanceof Error
							? error.message
							: String(error)
					},
				}),
			),
		)
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
