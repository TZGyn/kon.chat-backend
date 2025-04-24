import { DataStreamWriter, tool } from 'ai'
import { z } from 'zod'
import { web_reader } from './web-reader'
import { academic_search } from './academic-search'
import { image_generation } from './google-imagen'
import { x_search } from './x-search'
import { web_search } from './web-search'

export const toolList = [
	'chat',
	'x_search',
	'web_search',
	'academic_search',
	'web_reader',
	'gpt-image-1',
] as const

export type Tool = (typeof toolList)[number]

export const tools = (
	token: string,
	chatId: string,
	dataStream: DataStreamWriter,
	mode: Tool,
) => {
	const toolMap = {
		chat: {
			image_generation: image_generation({ chatId, token }),
			// image_captioning: toolList.image_captioning,
		},
		x_search: { x_search: x_search() },
		web_search: { web_search: web_search({ dataStream }) },
		academic_search: { academic_search: academic_search() },
		web_reader: { web_reader: web_reader() },
		'gpt-image-1': {},
	} as const

	return toolMap[mode]
}

export const activeTools = (
	mode: 'x_search' | 'chat' | 'web_search' | 'web_reader' | 'image',
) => {
	const toolMap = {
		x_search: ['x_search'],
		chat: ['image_generation'],
		web_search: ['web_search'],
		web_reader: ['web_reader'],
		image: ['generate_image'],
	} as const
	return toolMap[mode]
}
