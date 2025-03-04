import { convertToCoreMessages } from 'ai'
import { getMostRecentUserMessage } from './utils'
import { modelSchema } from './model'
import { z } from 'zod'

export const processMessages = ({
	messages,
	provider,
}: {
	messages: any[]
	provider: z.infer<typeof modelSchema>
}) => {
	let coreMessages = convertToCoreMessages(messages)
	const userMessage = getMostRecentUserMessage(coreMessages)
	const userMessageDate = Date.now()

	if (!userMessage) {
		return { error: 'No User Message' }
	}

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
	return { coreMessages, userMessage, userMessageDate }
}
