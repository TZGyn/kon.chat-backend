import {
	AssistantContent,
	CoreAssistantMessage,
	CoreMessage,
	CoreToolMessage,
	createDataStreamResponse,
	smoothStream,
	streamText,
	TextStreamPart,
	ToolContent,
	ToolSet,
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
import { chat, message, upload } from '$lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google'
import { redis } from '$lib/redis'
import { getModel, modelSchema } from '$lib/model'
import { checkNewChat, processMessages } from '$lib/message'
import { checkRatelimit, Limit } from '$lib/ratelimit'
import {
	mergeChunksToResponse,
	updateUserChatAndLimit,
} from '$lib/chat/utils'
import { serialize } from 'hono/utils/cookie'
import { activeTools, tools } from '$lib/ai/tools'
import { nanoid } from '$lib/utils'
import { s3Client } from '$lib/s3'

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
			createdAt: true,
			updatedAt: true,
		},
		where: (chat, { eq }) => eq(chat.userId, user.id),
		orderBy: (chat, { desc }) => [desc(chat.createdAt)],
	})

	return c.json({ chats })
})

app.get('/sync', async (c) => {
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
			userId: true,
			title: true,
			createdAt: true,
			updatedAt: true,
		},
		with: {
			messages: {
				columns: {
					content: true,
					role: true,
					model: true,
					id: true,
					responseId: true,
					createdAt: true,
					chatId: true,
					provider: true,
					providerMetadata: true,
				},
				orderBy: (message, { asc }) => [asc(message.createdAt)],
			},
		},
		where: (chat, { eq }) => eq(chat.userId, user.id),
		orderBy: (chat, { desc }) => [desc(chat.createdAt)],
	})

	return c.json({
		chats: chats.map((chat) => {
			const { userId: chatUserId, ...rest } = chat
			return { ...rest, isOwner: user.id === chatUserId }
		}),
	})
})

app.post(
	'/branch',
	zValidator(
		'json',
		z.object({
			chat_id: z.string(),
			new_chat_id: z.string(),
			at_message_id: z.string(),
		}),
	),
	async (c) => {
		const token = getCookie(c, 'session') ?? null
		const { at_message_id, chat_id, new_chat_id } =
			c.req.valid('json')

		if (token === null) {
			return c.text('You must be logged in', 401)
		}

		const { session, user } = await validateSessionToken(token)

		if (!user) {
			return c.text('You must be logged in', 401)
		}

		if (session !== null) {
			setSessionTokenCookie(c, token, session.expiresAt)
		} else {
			deleteSessionTokenCookie(c)
		}

		const existingChat = await db.query.chat.findFirst({
			where: (chat, { eq, and, or }) =>
				and(
					eq(chat.id, chat_id),
					or(eq(chat.userId, user.id), eq(chat.visibility, 'public')),
				),
			with: {
				messages: {
					orderBy: (message, { asc }) => [asc(message.createdAt)],
				},
			},
		})

		if (!existingChat) {
			return c.text('No chat found', 401)
		}

		const clash = await db.query.chat.findFirst({
			where: (chat, t) => t.eq(chat.id, new_chat_id),
		})

		if (clash) {
			return c.text('New chat already exist', 400)
		}

		const attachments = existingChat.messages
			.slice(
				0,
				existingChat.messages.findIndex(
					(message) => message.id === at_message_id,
				) + 1,
			)
			.flatMap((message) => {
				let res: string[] = []
				if (typeof message.content === 'string') {
					return []
				}
				if (Array.isArray(message.content)) {
					for (const content of message.content) {
						if (content.type === 'text') {
							continue
						} else if (content.type === 'reasoning') {
							continue
						} else if (content.type === 'tool-call') {
							continue
						} else if (content.type === 'image') {
							const url = content.image as string

							if (
								Bun.env.APP_URL &&
								url.startsWith(Bun.env.APP_URL)
							) {
								const id = (content.image as string).split('/').pop()
								if (!id) continue
								res.push(id)
							}

							continue
						} else if (content.type === 'file') {
							const url = content.data as string

							if (
								Bun.env.APP_URL &&
								url.startsWith(Bun.env.APP_URL)
							) {
								const id = (content.data as string).split('/').pop()

								if (!id) continue
								res.push(id)
							}
						} else if (
							content.type === 'tool-result' &&
							content.toolName === 'image_generation' &&
							'files' in content.result
						) {
							const files: string[] = []
							for (const url of content.result.files as string[]) {
								if (
									Bun.env.APP_URL &&
									url.startsWith(Bun.env.APP_URL)
								) {
									const id = (url as string).split('/').pop()

									if (!id) continue
									files.push(id)
								}
							}
							res = [...res, ...files]
						}
					}
				}
				return res
			})

		await db.insert(chat).values({
			id: new_chat_id,
			title: existingChat.title + ' (branch)',
			userId: user.id,
			visibility: 'private',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})

		const uploads = await db.query.upload.findMany({
			where: (upload, t) => t.and(t.inArray(upload.id, attachments)),
		})

		const uploadsData = await Promise.all(
			uploads.map(async (upload) => {
				const existing = s3Client.file(upload.key)

				const copyId = `${
					user.id
				}/chat/${new_chat_id}/upload/${nanoid()}-${upload.name}`

				const uploadId =
					nanoid() + `.${upload.mimeType.split('/').pop()}`
				const copy = s3Client.file(copyId)

				await copy.write(existing)
				return {
					originalId: upload.id,
					id: uploadId,
					name: upload.name,
					createdAt: Date.now(),
					userId: user.id,
					key: copyId,
					size: upload.size,
					mimeType: upload.mimeType,
					visibility: 'private' as const,
				}
			}),
		)

		if (existingChat.messages.length > 0) {
			const now = Date.now()
			await db.insert(message).values(
				existingChat.messages
					.slice(
						0,
						existingChat.messages.findIndex(
							(message) => message.id === at_message_id,
						) + 1,
					)
					.map((message, index) => {
						const replaceAttachment = (content: unknown) => {
							let res = []
							if (typeof message.content === 'string') {
								return message.content
							}
							if (Array.isArray(message.content)) {
								for (const content of message.content) {
									if (content.type === 'text') {
										res.push(content)
									} else if (content.type === 'reasoning') {
										res.push(content)
									} else if (content.type === 'tool-call') {
										res.push(content)
									} else if (
										content.type === 'tool-result' &&
										content.toolName === 'image_generation' &&
										'files' in content.result
									) {
										const files = content.result.files as string[]

										const final_files: string[] = []
										for (const url of files) {
											if (
												Bun.env.APP_URL &&
												url.startsWith(Bun.env.APP_URL)
											) {
												const id = url.split('/').pop()
												if (!id) continue
												const upload = uploadsData.find(
													(data) => data.originalId === id,
												)
												if (upload) {
													final_files.push(
														Bun.env.APP_URL +
															'/file-upload/' +
															upload.id,
													)
												}
												continue
											}
										}

										res.push({
											...content,
											result: { files: final_files },
										})
									} else if (content.type === 'image') {
										const url = content.image as string

										if (
											Bun.env.APP_URL &&
											url.startsWith(Bun.env.APP_URL)
										) {
											const id = (content.image as string)
												.split('/')
												.pop()
											if (!id) continue
											const upload = uploadsData.find(
												(data) => data.originalId === id,
											)
											if (upload) {
												res.push({
													type: 'image',
													image:
														Bun.env.APP_URL +
														'/file-upload/' +
														upload.id,
												})
											} else {
												res.push(content)
											}
											continue
										}

										continue
									} else if (content.type === 'file') {
										const url = content.data as string

										if (
											Bun.env.APP_URL &&
											url.startsWith(Bun.env.APP_URL)
										) {
											const id = (content.data as string)
												.split('/')
												.pop()

											if (!id) continue

											const upload = uploadsData.find(
												(data) => data.originalId === id,
											)
											if (upload) {
												res.push({
													type: 'file',
													data:
														Bun.env.APP_URL +
														'/file-upload/' +
														upload.id,
													mimeType: upload.mimeType,
												})
											} else {
												res.push(content)
											}
											continue
										}
									} else {
										res.push(content)
									}
								}
							}
							return res
						}
						return {
							...message,
							id: nanoid(),
							chatId: new_chat_id,
							createdAt: now + index,
							content: replaceAttachment(message.content),
						}
					}),
			)
		}

		if (uploadsData.length > 0) {
			await db.insert(upload).values([...uploadsData])
		}

		return c.json({ success: true })
	},
)

app.get('/:chat_id', async (c) => {
	const token = getCookie(c, 'session') ?? null
	const chatId = c.req.param('chat_id')

	if (token === null) {
		const chat = await db.query.chat.findFirst({
			where: (chat, { eq, and, or }) =>
				and(eq(chat.id, chatId), eq(chat.visibility, 'public')),
			with: {
				messages: {
					columns: {
						content: true,
						role: true,
						model: true,
						id: true,
						responseId: true,
						createdAt: true,
						chatId: true,
						provider: true,
						providerMetadata: true,
					},
					orderBy: (message, { asc }) => [asc(message.createdAt)],
				},
			},
		})

		if (chat) {
			const { userId: chatUserId, ...rest } = chat

			return c.json({
				chat: { ...rest, isOwner: false },
			})
		}

		return c.json({ chat: null })
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		const chat = await db.query.chat.findFirst({
			where: (chat, { eq, and, or }) =>
				and(eq(chat.id, chatId), eq(chat.visibility, 'public')),
			with: {
				messages: {
					columns: {
						content: true,
						role: true,
						model: true,
						id: true,
						responseId: true,
						createdAt: true,
						chatId: true,
						provider: true,
						providerMetadata: true,
					},
					orderBy: (message, { asc }) => [asc(message.createdAt)],
				},
			},
		})

		if (chat) {
			const { userId: chatUserId, ...rest } = chat

			return c.json({
				chat: { ...rest, isOwner: false },
			})
		}
		return c.json({ chat: null })
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	const chat = await db.query.chat.findFirst({
		where: (chat, { eq, and, or }) =>
			and(
				eq(chat.id, chatId),
				or(eq(chat.userId, user.id), eq(chat.visibility, 'public')),
			),
		with: {
			messages: {
				columns: {
					content: true,
					role: true,
					model: true,
					id: true,
					responseId: true,
					createdAt: true,
					chatId: true,
					provider: true,
					providerMetadata: true,
				},
				orderBy: (message, { asc }) => [asc(message.createdAt)],
			},
		},
	})

	if (chat) {
		const { userId: chatUserId, ...rest } = chat

		return c.json({
			chat: { ...rest, isOwner: user.id === chatUserId },
		})
	}

	return c.json({ chat: null })
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

		if (searchGrounding && mode !== 'chat') {
			return c.text(
				'Google models does not support calling search grounding and tools at the same time',
				400,
			)
		}

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

		checkNewChat({
			chat_id: chatId,
			user_message: userMessage,
			token: token,
		})

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

		const chunks: Extract<
			TextStreamPart<ToolSet>,
			{
				type:
					| 'text-delta'
					| 'reasoning'
					| 'source'
					| 'tool-call'
					| 'tool-call-streaming-start'
					| 'tool-call-delta'
					| 'tool-result'
			}
		>[] = []

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
					chat: `
						YOU ARE NOT ALLOWED TO CALL ANY TOOLS, DONT USE PREVIOUS CHATS TO FAKE CALL TOOLS
						ONLY TREAT THIS AS TEXT TO TEXT CHAT

						You have also been given image generation tool, do not ask for confirmation, just relay the user request
						The tool will take in an image url if its use for editing, please decide whether or not to include an image url based on the context
						For example: if an user ask to generate an image of a cat with transparent background
						Dont say back to the user you cant generate a transparent background 
						Just use the tool and let the user see the result themselves
						Another example: If an user ask to generate an image of a cat, then ask to give it clothes, please use the generated cat image
					`,

					// You have also been given other image tools, use the one you feel most appropriate for the task
					// You are allowed to use the file links in the image_generation tools (if you used them)
					x_search: `
						You have been given an ability to search X(formerly Twitter)'s posts
						'You MUST run the tool first exactly once'
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					web_search: `
						You have been given a web search ability, 
						'You MUST run the tool first exactly once'
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					academic_search: `
						You have been given an ability to search academic papers
						'You MUST run the tool first exactly once'
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					web_reader: `
						You have been given an ability to fetch url as markdown 
						'You MUST run the tool first exactly once'
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
					image: `
						You have been given an ability to generate image 
						'You MUST run the tool first exactly once'
						USE 1:1 aspect ratio if not specified and 1 image as default unless specified
						DO NOT ASK THE USER FOR CONFIRMATION!
					`,
				}

				const result = streamText({
					model: model,
					messages: coreMessages,
					system: `
						You are a chat assistant

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
						You must put the programming language for codeblock so frontend can make correct syntax highlighting
						eg:
						\`\`\`javascript
						javascript code
						\`\`\`

						Do not generate tool call details to the user
						It is a must to generate some text, letting the user knows your thinking process before using a tool.
						Thus providing better user experience, rather than immediately jump to using the tool and generate a conclusion

						Common Order: Tool, Text
						Better order you must follow: Text, Tool, Text

						${additionalSystemPrompt[mode]}
					`,
					providerOptions: providerOptions,
					abortSignal: c.req.raw.signal,
					onChunk: ({ chunk }) => {
						chunks.push(chunk)
					},
					maxSteps: 5,
					// experimental_activeTools: [...activeTools(mode)],
					tools: {
						...tools(token, chatId, dataStream, mode),
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
						// console.log(data)
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
						// const util = require('util')
						// console.log('on finish')
						// console.log(
						// 	util.inspect(response.messages, {
						// 		showHidden: false,
						// 		depth: null,
						// 		colors: true,
						// 	}),
						// )
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
							response_id: response.id,
						})
					},
				})

				result.mergeIntoDataStream(dataStream, {
					sendReasoning: true,
				})

				// for await (const part of result.textStream) {
				// 	console.log(part)
				// }
			},
			onError: (error) => {
				const responseMessages = mergeChunksToResponse(chunks)
				updateUserChatAndLimit({
					chatId,
					messages: responseMessages,
					provider,
					providerMetadata: {
						kon_chat: {
							status: 'error',
							error: {
								type: 'stopped_by_user',
								message: 'Stopped By User',
							},
						},
					},
					reasoning: undefined,
					token,
					usage: {
						completionTokens: 0,
						promptTokens: 0,
						totalTokens: 0,
					},
					userMessage,
					userMessageDate,
					mode,
					response_id: nanoid(),
				})
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

	const delete_messages = await db
		.delete(message)
		.where(eq(message.chatId, chatId))
		.returning()

	const attachments = delete_messages.flatMap((message) => {
		let res = []
		if (typeof message.content === 'string') {
			return []
		}
		if (Array.isArray(message.content)) {
			for (const content of message.content) {
				if (content.type === 'text') {
					continue
				} else if (content.type === 'reasoning') {
					continue
				} else if (content.type === 'tool-call') {
					continue
				} else if (
					content.type === 'tool-result' &&
					content.toolName === 'image_generation' &&
					'files' in content.result
				) {
					for (const url of content.result.files as string[]) {
						if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
							const id = url.split('/').pop()
							if (!id) continue
							res.push(id)
						}
					}
				} else if (content.type === 'image') {
					const url = content.image as string

					if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
						const id = (content.image as string).split('/').pop()
						if (!id) continue
						res.push(id)
					}

					continue
				} else if (content.type === 'file') {
					const url = content.data as string

					if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
						const id = (content.data as string).split('/').pop()

						if (!id) continue
						res.push(id)
					}
				}
			}
		}
		return res
	})

	const deleted_uploads = await db
		.delete(upload)
		.where(
			and(
				inArray(upload.id, attachments),
				eq(upload.userId, user.id),
			),
		)
		.returning()

	await Promise.all(
		deleted_uploads.map(async (upload) => {
			const s3file = s3Client.file(upload.key)
			await s3file.delete()
		}),
	)

	return c.json({ success: true })
})

app.post(
	'/:chat_id/upload',
	zValidator(
		'form',
		z.object({
			file: z
				.instanceof(File)
				.refine((file) => file.size <= 5 * 1024 * 1024, {
					message: 'File size should be less than 5MB',
				})
				// Update the file type based on the kind of files you want to accept
				.refine(
					(file) =>
						[
							'image/jpeg',
							'image/png',
							'application/pdf',
							// 'text/csv',
							// 'text/plain',
						].includes(file.type),
					{
						message: 'File type not supported',
					},
				),
		}),
	),
	async (c) => {
		const token = getCookie(c, 'session') ?? null
		const chatId = c.req.param('chat_id')

		if (token === null) {
			return c.text('Unauthenticated', 401)
		}

		const { session, user } = await validateSessionToken(token)

		if (!user) {
			return c.json({ link: '' }, 401)
		}
		if (!['pro', 'basic'].includes(user.plan)) {
			return c.text(
				'You need to have basic/pro plan to use this feature',
				400,
			)
		}

		if (session !== null) {
			setSessionTokenCookie(c, token, session.expiresAt)
		} else {
			deleteSessionTokenCookie(c)
		}

		const existingChat = await db.query.chat.findFirst({
			where: (chat, t) =>
				t.and(t.eq(chat.id, chatId), t.eq(chat.userId, user.id)),
		})

		if (!existingChat) return c.text('Unauthenticated Upload', 401)

		const file = c.req.valid('form').file

		const id = `${user.id}/chat/${chatId}/upload/${nanoid()}-${
			file.name
		}`
		const s3file = s3Client.file(id)

		await s3file.write(file)

		const uploadId = nanoid() + `.${file.type.split('/').pop()}`
		await db.insert(upload).values({
			id: uploadId,
			userId: user.id,
			key: id,
			mimeType: file.type,
			name: file.name,
			size: file.size,
			visibility: existingChat.visibility,
			createdAt: Date.now(),
		})

		return c.json({ id: uploadId })
	},
)

app.put(
	'/:chat_id/change_visibility',
	zValidator(
		'json',
		z.object({
			visibility: z.enum(['private', 'public']),
		}),
	),
	async (c) => {
		const token = getCookie(c, 'session') ?? null

		if (token === null) {
			return c.json({ link: '' }, 401)
		}

		const { session, user } = await validateSessionToken(token)

		if (!user) {
			return c.json({ link: '' }, 401)
		}

		if (session !== null) {
			setSessionTokenCookie(c, token, session.expiresAt)
		} else {
			deleteSessionTokenCookie(c)
		}

		const chat_id = c.req.param('chat_id')

		const { visibility } = c.req.valid('json')

		const existingChat = await db.query.chat.findFirst({
			where: (chat, t) =>
				t.and(t.eq(chat.id, chat_id), t.eq(chat.userId, user.id)),
			with: {
				messages: true,
			},
		})

		if (existingChat) {
			await db
				.update(chat)
				.set({
					visibility: visibility,
				})
				.where(and(eq(chat.id, chat_id), eq(chat.userId, user.id)))

			const attachments = existingChat.messages.flatMap((message) => {
				let res: string[] = []
				if (typeof message.content === 'string') {
					return []
				}
				if (Array.isArray(message.content)) {
					for (const content of message.content) {
						if (content.type === 'text') {
							continue
						} else if (content.type === 'reasoning') {
							continue
						} else if (content.type === 'tool-call') {
							continue
						} else if (content.type === 'image') {
							const url = content.image as string

							if (
								Bun.env.APP_URL &&
								url.startsWith(Bun.env.APP_URL)
							) {
								const id = (content.image as string).split('/').pop()
								if (!id) continue
								res.push(id)
							}

							continue
						} else if (content.type === 'file') {
							const url = content.data as string

							if (
								Bun.env.APP_URL &&
								url.startsWith(Bun.env.APP_URL)
							) {
								const id = (content.data as string).split('/').pop()

								if (!id) continue
								res.push(id)
							}
						} else if (
							content.type === 'tool-result' &&
							content.toolName === 'image_generation' &&
							'files' in content.result
						) {
							const files: string[] = []
							for (const url of content.result.files as string[]) {
								if (
									Bun.env.APP_URL &&
									url.startsWith(Bun.env.APP_URL)
								) {
									const id = (url as string).split('/').pop()

									if (!id) continue
									files.push(id)
								}
							}
							res = [...res, ...files]
						}
					}
				}
				return res
			})

			await db
				.update(upload)
				.set({
					visibility: visibility,
				})
				.where(
					and(
						inArray(upload.id, attachments),
						eq(upload.userId, user.id),
					),
				)
		}

		return c.json({ success: true }, 200)
	},
)

app.post('/:chat_id/copy', async (c) => {
	const token = getCookie(c, 'session') ?? null

	if (token === null) {
		return c.json({ id: '' }, 401)
	}

	const { session, user } = await validateSessionToken(token)

	if (!user) {
		return c.json({ id: '' }, 401)
	}

	if (session !== null) {
		setSessionTokenCookie(c, token, session.expiresAt)
	} else {
		deleteSessionTokenCookie(c)
	}

	const chat_id = c.req.param('chat_id')

	const existingChat = await db.query.chat.findFirst({
		where: (chat, t) =>
			t.and(
				t.eq(chat.id, chat_id),
				t.or(
					t.eq(chat.userId, user.id),
					t.eq(chat.visibility, 'public'),
				),
			),
		with: {
			messages: true,
		},
	})

	if (!existingChat) return c.json({ id: '' }, 404)

	const attachments = existingChat.messages.flatMap((message) => {
		let res: string[] = []
		if (typeof message.content === 'string') {
			return []
		}
		if (Array.isArray(message.content)) {
			for (const content of message.content) {
				if (content.type === 'text') {
					continue
				} else if (content.type === 'reasoning') {
					continue
				} else if (content.type === 'tool-call') {
					continue
				} else if (content.type === 'image') {
					const url = content.image as string

					if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
						const id = (content.image as string).split('/').pop()
						if (!id) continue
						res.push(id)
					}

					continue
				} else if (content.type === 'file') {
					const url = content.data as string

					if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
						const id = (content.data as string).split('/').pop()

						if (!id) continue
						res.push(id)
					}
				} else if (
					content.type === 'tool-result' &&
					'files' in content.result
				) {
					const files: string[] = []
					for (const url of content.result.files as string[]) {
						if (Bun.env.APP_URL && url.startsWith(Bun.env.APP_URL)) {
							const id = (url as string).split('/').pop()

							if (!id) continue
							files.push(id)
						}
					}
					res = [...res, ...files]
				}
			}
		}
		return res
	})

	const newChatId = nanoid()

	await db.insert(chat).values({
		id: newChatId,
		title: existingChat.title,
		userId: user.id,
		visibility: 'private',
		createdAt: Date.now(),
	})

	const uploads = await db.query.upload.findMany({
		where: (upload, t) => t.and(t.inArray(upload.id, attachments)),
	})

	const uploadsData = await Promise.all(
		uploads.map(async (upload) => {
			const existing = s3Client.file(upload.key)

			const copyId = `${
				user.id
			}/chat/${newChatId}/upload/${nanoid()}-${upload.name}`

			const uploadId =
				nanoid() + `.${upload.mimeType.split('/').pop()}`
			const copy = s3Client.file(copyId)

			await copy.write(existing)
			return {
				originalId: upload.id,
				id: uploadId,
				name: upload.name,
				createdAt: Date.now(),
				userId: user.id,
				key: copyId,
				size: upload.size,
				mimeType: upload.mimeType,
				visibility: 'private' as const,
			}
		}),
	)

	if (existingChat.messages.length > 0) {
		const now = Date.now()
		await db.insert(message).values(
			existingChat.messages.map((message, index) => {
				const replaceAttachment = (content: unknown) => {
					let res = []
					if (typeof message.content === 'string') {
						return message.content
					}
					if (Array.isArray(message.content)) {
						for (const content of message.content) {
							if (content.type === 'text') {
								res.push(content)
							} else if (content.type === 'reasoning') {
								res.push(content)
							} else if (content.type === 'tool-call') {
								res.push(content)
							} else if (content.type === 'image') {
								const url = content.image as string

								if (
									Bun.env.APP_URL &&
									url.startsWith(Bun.env.APP_URL)
								) {
									const id = (content.image as string)
										.split('/')
										.pop()
									if (!id) continue
									const upload = uploadsData.find(
										(data) => data.originalId === id,
									)
									if (upload) {
										res.push({
											type: 'image',
											image:
												Bun.env.APP_URL + '/file-upload/' + upload.id,
										})
									} else {
										res.push(content)
									}
									continue
								}

								continue
							} else if (content.type === 'file') {
								const url = content.data as string

								if (
									Bun.env.APP_URL &&
									url.startsWith(Bun.env.APP_URL)
								) {
									const id = (content.data as string).split('/').pop()

									if (!id) continue

									const upload = uploadsData.find(
										(data) => data.originalId === id,
									)
									if (upload) {
										res.push({
											type: 'file',
											data:
												Bun.env.APP_URL + '/file-upload/' + upload.id,
											mimeType: upload.mimeType,
										})
									} else {
										res.push(content)
									}
									continue
								}
							} else {
								res.push(content)
							}
						}
					}
					return res
				}
				return {
					...message,
					id: nanoid(),
					chatId: newChatId,
					createdAt: now + index,
					content: replaceAttachment(message.content),
				}
			}),
		)
	}

	if (uploadsData.length > 0) {
		await db.insert(upload).values([...uploadsData])
	}

	return c.json({ id: newChatId }, 200)
})

export default app
