import {
	generateTitleFromUserMessage,
	sanitizeResponseMessages,
} from '$lib/ai/utils'
import { validateSessionToken } from '$lib/auth/session'
import { db } from '$lib/db'
import { chat, message } from '$lib/db/schema'
import { Provider } from '$lib/model'
import { updateUserRatelimit } from '$lib/ratelimit'
import {
	CoreAssistantMessage,
	CoreToolMessage,
	CoreUserMessage,
	generateId,
	LanguageModelUsage,
} from 'ai'

export const updateUserChatAndLimit = async ({
	token,
	chatId,
	userMessage,
	userMessageDate,
	messages,
	reasoning,
	provider,
	providerMetadata,
	brave,
	jina,
	usage,
	search,
	mode,
}: {
	token: string
	chatId: string
	userMessage: CoreUserMessage
	userMessageDate: number
	messages: Array<CoreToolMessage | CoreAssistantMessage>
	reasoning: string | undefined
	provider: Provider
	providerMetadata: any | undefined
	brave: any
	jina: any
	usage: LanguageModelUsage
	search: boolean
	mode: 'x_search' | 'chat' | 'web_search' | string
}) => {
	const { session, user: loggedInUser } = await validateSessionToken(
		token,
	)

	if (!loggedInUser) return

	const existingChat = await db.query.chat.findFirst({
		where: (chat, { eq, and }) =>
			and(eq(chat.id, chatId), eq(chat.userId, loggedInUser.id)),
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
			messages: messages,
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

	await updateUserRatelimit({
		provider,
		search,
		user: loggedInUser,
		mode,
	})
}

export const updateUserLimit = async ({
	token,
	provider,
	search,
}: {
	token: string
	provider: Provider
	search: boolean
}) => {
	const { session, user: loggedInUser } = await validateSessionToken(
		token,
	)

	if (!loggedInUser) return

	await updateUserRatelimit({
		provider,
		search,
		user: loggedInUser,
		mode: 'chat',
	})
}
