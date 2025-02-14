import { fetch } from 'bun'

export const jinaRead = async (url: string) => {
	try {
		const response = await fetch(
			`https://r.jina.ai/${encodeURIComponent(url)}`,
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${Bun.env.JINA_API_KEY}`,
					Accept: 'application/json',
					'Content-Type': 'application/json',
					'X-No-Cache': 'true',
					'X-Retain-Images': 'none',
				},
			},
		)

		return (await response.json()) as {
			code: number
			status: number
			data: {
				title: string
				description: string
				url: string
				content: string
				usage: {
					tokens: number
				}
			}
		}
	} catch (error) {
		console.log(error)
		return
	}
}
