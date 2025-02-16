import { Redis } from '@upstash/redis'

export const redis = new Redis({
	url: 'https://relaxed-bug-15714.upstash.io',
	token: Bun.env.UPSTASH_SECRET,
})
