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
	usage,
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
	usage: LanguageModelUsage
	mode:
		| 'x_search'
		| 'chat'
		| 'web_search'
		| 'academic_search'
		| 'web_reader'
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
					...usage,
					createdAt: date,
				}
			},
		),
	)

	await updateUserRatelimit({
		provider,
		user: loggedInUser,
		mode,
	})
}

export const updateUserLimit = async ({
	token,
	provider,
}: {
	token: string
	provider: Provider
}) => {
	const { session, user: loggedInUser } = await validateSessionToken(
		token,
	)

	if (!loggedInUser) return

	await updateUserRatelimit({
		provider,
		user: loggedInUser,
		mode: 'chat',
	})
}
