import {
	DataStreamWriter,
	experimental_generateImage as generateImage,
	tool,
} from 'ai'
import { z } from 'zod'
import { exa } from './exa'
import { tavily } from './tavily'
import { jinaRead } from './jina'
import { vertex } from './model'
import { validateSessionToken } from '$lib/auth/session'

type XResult = {
	id: string
	url: string
	title: string
	author?: string
	publishedDate?: string
	text: string
	highlights?: string[]
	tweetId: string
}

async function isValidImageUrl(url: string): Promise<boolean> {
	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 5000)

		const response = await fetch(url, {
			method: 'HEAD',
			signal: controller.signal,
		})

		clearTimeout(timeout)

		return (
			response.ok &&
			(response.headers.get('content-type')?.startsWith('image/') ??
				false)
		)
	} catch {
		return false
	}
}

function sanitizeUrl(url: string): string {
	return url.replace(/\s+/g, '%20')
}

const extractDomain = (url: string): string => {
	const urlPattern = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i
	return url.match(urlPattern)?.[1] || url
}

const deduplicateByDomainAndUrl = <T extends { url: string }>(
	items: T[],
): T[] => {
	const seenDomains = new Set<string>()
	const seenUrls = new Set<string>()

	return items.filter((item) => {
		const domain = extractDomain(item.url)
		const isNewUrl = !seenUrls.has(item.url)
		const isNewDomain = !seenDomains.has(domain)

		if (isNewUrl && isNewDomain) {
			seenUrls.add(item.url)
			seenDomains.add(domain)
			return true
		}
		return false
	})
}

export const toolList = [
	'chat',
	'x_search',
	'web_search',
	'academic_search',
	'web_reader',
] as const

export type Tool = (typeof toolList)[number]

export const tools = (dataStream: DataStreamWriter, mode: Tool) => {
	const toolList = {
		stock_chart: tool({
			description: 'Get stock data',
			parameters: z.object({
				symbol: z.string().describe('symbol of the stock'),
			}),
		}),
		x_search: tool({
			description: 'Search X (formerly Twitter) posts.',
			parameters: z.object({
				query: z
					.string()
					.describe(
						'The search query, if a username is provided put in the query with @username',
					),
				startDate: z
					.string()
					.optional()
					.describe(
						'The start date for the search in YYYY-MM-DD format',
					),
				endDate: z
					.string()
					.optional()
					.describe(
						'The end date for the search in YYYY-MM-DD format',
					),
			}),
			execute: async ({
				query,
				startDate,
				endDate,
			}: {
				query: string
				startDate?: string
				endDate?: string
			}) => {
				try {
					const result = await exa.searchAndContents(query, {
						type: 'keyword',
						numResults: 15,
						text: true,
						highlights: true,
						includeDomains: ['twitter.com', 'x.com'],
						startPublishedDate: startDate,
						endPublishedDate: endDate,
					})
					// Extract tweet ID from URL
					const extractTweetId = (url: string): string | null => {
						const match = url.match(
							/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/,
						)
						return match ? match[1] : null
					}
					// Process and filter results
					const processedResults = result.results.reduce<
						Array<XResult>
					>((acc, post) => {
						const tweetId = extractTweetId(post.url)
						if (tweetId) {
							acc.push({
								...post,
								tweetId,
								title: post.title || '',
							})
						}
						return acc
					}, [])
					return processedResults
				} catch (error) {
					console.error('X search error:', error)
					throw error
				}
			},
		}),
		web_search: tool({
			description:
				'Search the web for information with multiple queries, max results and search depth. Note: This is different from google search grounding, so dont call this if youre using google search grounding',
			parameters: z.object({
				queries: z.array(
					z
						.string()
						.describe(
							'Array of search queries to look up on the web.',
						),
				),
				maxResults: z.array(
					z
						.number()
						.describe(
							'Array of maximum number of results to return per query.',
						),
				),
				topics: z.array(
					z
						.enum(['general', 'news'])
						.describe('Array of topic types to search for.'),
				),
				searchDepth: z.array(
					z
						.enum(['basic', 'advanced'])
						.describe('Array of search depths to use.'),
				),
				exclude_domains: z
					.array(z.string())
					.describe(
						'A list of domains to exclude from all search results.',
					),
			}),
			execute: async ({
				queries,
				maxResults,
				topics,
				searchDepth,
				exclude_domains,
			}: {
				queries: string[]
				maxResults: number[]
				topics: ('general' | 'news')[]
				searchDepth: ('basic' | 'advanced')[]
				exclude_domains?: string[]
			}) => {
				const includeImageDescriptions = true

				// Execute searches in parallel
				const searchPromises = queries.map(async (query, index) => {
					const data = await tavily.search(query, {
						topic: topics[index] || topics[0] || 'general',
						days: topics[index] === 'news' ? 7 : undefined,
						maxResults: maxResults[index] || maxResults[0] || 10,
						searchDepth:
							searchDepth[index] || searchDepth[0] || 'basic',
						includeAnswer: true,
						includeImages: true,
						includeImageDescriptions: includeImageDescriptions,
						excludeDomains: exclude_domains,
					})

					// Add annotation for query completion
					dataStream.writeMessageAnnotation({
						type: 'query_completion',
						data: {
							query,
							index,
							total: queries.length,
							status: 'completed',
							resultsCount: data.results.length,
							imagesCount: data.images.length,
						},
					})

					return {
						query,
						results: deduplicateByDomainAndUrl(data.results).map(
							(obj: any) => ({
								url: obj.url,
								title: obj.title,
								content: obj.content,
								raw_content: obj.raw_content,
								published_date:
									topics[index] === 'news'
										? obj.published_date
										: undefined,
							}),
						),
						images: includeImageDescriptions
							? await Promise.all(
									deduplicateByDomainAndUrl(data.images).map(
										async ({
											url,
											description,
										}: {
											url: string
											description?: string
										}) => {
											const sanitizedUrl = sanitizeUrl(url)
											const isValid = await isValidImageUrl(
												sanitizedUrl,
											)
											return isValid
												? {
														url: sanitizedUrl,
														description: description ?? '',
												  }
												: null
										},
									),
							  ).then((results) =>
									results.filter(
										(
											image,
										): image is {
											url: string
											description: string
										} =>
											image !== null &&
											typeof image === 'object' &&
											typeof image.description === 'string' &&
											image.description !== '',
									),
							  )
							: await Promise.all(
									deduplicateByDomainAndUrl(data.images).map(
										async ({ url }: { url: string }) => {
											const sanitizedUrl = sanitizeUrl(url)
											return (await isValidImageUrl(sanitizedUrl))
												? sanitizedUrl
												: null
										},
									),
							  ).then(
									(results) =>
										results.filter((url) => url !== null) as string[],
							  ),
					}
				})

				const searchResults = await Promise.all(searchPromises)

				return {
					searches: searchResults,
				}
			},
		}),
		academic_search: tool({
			description: 'Search academic papers and research.',
			parameters: z.object({
				query: z.string().describe('The search query'),
			}),
			execute: async ({ query }: { query: string }) => {
				try {
					// Search academic papers with content summary
					const result = await exa.searchAndContents(query, {
						type: 'auto',
						numResults: 20,
						category: 'research paper',
						summary: {
							query: 'Abstract of the Paper',
						},
					})

					// Process and clean results
					const processedResults = result.results.reduce<
						typeof result.results
					>((acc, paper) => {
						// Skip if URL already exists or if no summary available
						if (
							acc.some((p) => p.url === paper.url) ||
							!paper.summary
						)
							return acc

						// Clean up summary (remove "Summary:" prefix if exists)
						const cleanSummary = paper.summary.replace(
							/^Summary:\s*/i,
							'',
						)

						// Clean up title (remove [...] suffixes)
						const cleanTitle = paper.title?.replace(/\s\[.*?\]$/, '')

						acc.push({
							...paper,
							title: cleanTitle || '',
							summary: cleanSummary,
						})

						return acc
					}, [])

					// Take only the first 10 unique, valid results
					const limitedResults = processedResults.slice(0, 10)

					return {
						results: limitedResults,
					}
				} catch (error) {
					console.error('Academic search error:', error)
					throw error
				}
			},
		}),
		web_reader: tool({
			description: 'Get page content as markdown given an url.',
			parameters: z.object({
				url: z.string().describe('The url of the page'),
			}),
			execute: async ({ url }) => {
				try {
					const result = await jinaRead(url)
					return { result }
				} catch (error) {
					console.error('Jina reader error:', error)
					throw error
				}
			},
		}),
		// generate_image: tool({
		// 	description: 'generate an image',
		// 	parameters: z.object({
		// 		prompt: z.string().describe('prompt to generate the image'),
		// 		negative_prompt: z
		// 			.string()
		// 			.describe('prompt to tell the model not to generate'),
		// 		count: z.number().describe('number of image (max 4)'),
		// 		aspect_ratio: z
		// 			.string()
		// 			.describe(
		// 				'aspect ratio, one of these: 1:1, 3:4, 4:3, 9:16, 16:9',
		// 			),
		// 	}),
		// 	execute: async ({
		// 		count,
		// 		prompt,
		// 		aspect_ratio,
		// 		negative_prompt,
		// 	}) => {
		// 		const { session, user: loggedInUser } =
		// 			await validateSessionToken(token)

		// 		if (!loggedInUser) return

		// 		const getAspectRatio = (aspect_ratio: string) => {
		// 			const ratios = [
		// 				'1:1',
		// 				'3:4',
		// 				'4:3',
		// 				'9:16',
		// 				'16:9',
		// 			] as const
		// 			if (ratios.includes(aspect_ratio as any)) {
		// 				return aspect_ratio as (typeof ratios)[number]
		// 			} else {
		// 				return '1:1'
		// 			}
		// 		}
		// 		try {
		// 			const result = await generateImage({
		// 				model: vertex.image('imagen-3.0-generate-001', {
		// 					maxImagesPerCall: 4,
		// 				}),
		// 				prompt: prompt,
		// 				aspectRatio: getAspectRatio(aspect_ratio),
		// 				n: count > 4 ? 4 : count,
		// 				providerOptions: {
		// 					vertex: { negativePrompt: negative_prompt },
		// 				},
		// 			})

		// 			return { images: result.images }
		// 		} catch (error) {
		// 			return { images: [] }
		// 		}
		// 	},
		// }),
	}

	const toolMap = {
		chat: {},
		x_search: { x_search: toolList.x_search },
		web_search: { web_search: toolList.web_search },
		academic_search: { academic_search: toolList.academic_search },
		web_reader: { web_reader: toolList.web_reader },
	} as const

	return toolMap[mode]
}

export const activeTools = (
	mode: 'x_search' | 'chat' | 'web_search' | 'web_reader' | 'image',
) => {
	const toolMap = {
		x_search: ['x_search'],
		chat: [],
		web_search: ['web_search'],
		web_reader: ['web_reader'],
		image: ['generate_image'],
	} as const
	return toolMap[mode]
}
