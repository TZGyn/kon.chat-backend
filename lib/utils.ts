import { CoreMessage } from 'ai'

export function getMostRecentUserMessage(
	messages: Array<CoreMessage>,
) {
	const userMessages = messages.filter(
		(message) => message.role === 'user',
	)
	return userMessages.at(-1)
}
