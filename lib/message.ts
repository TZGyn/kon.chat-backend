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
	// console.log(
	// 	inspect(messages, false, null, true /* enable colors */),
	// )
	messages = messages
		.map((message) => ({
			...message,
			toolInvocations:
				message.toolInvocations?.filter((tool) => {
					return 'result' in tool
				}) || [],
			parts:
				message.parts?.filter((part) => {
					if (part.type === 'reasoning' && !part.reasoning)
						return false
					if (part.type !== 'tool-invocation') return true
					if (!('toolInvocation' in part)) return false
					return 'result' in part.toolInvocation
				}) || [],
		}))
		.filter((message) => message.parts.length !== 0)
	let coreMessages = convertToCoreMessages(messages)
	const userMessage = getMostRecentUserMessage(coreMessages)
	const userMessageDate = Date.now()

	coreMessages = coreMessages.map((message) => {
		if (message.role === 'user') {
			return message
		} else {
			if (message.role === 'tool') {
				return {
					...message,
					content: message.content.filter((content) => {
						if (!content.result) return false
						return true
					}),
				}
			}
			return message
		}
	})

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

	if (provider.name !== 'anthropic') {
		coreMessages = coreMessages.map((message) => {
			if (message.role === 'user') {
				if (Array.isArray(message.content)) {
					return {
						...message,
						content: message.content.filter((content) => {
							if (content.type === 'file') return false
							return true
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
