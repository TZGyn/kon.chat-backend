import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Webhooks } from '@polar-sh/hono'
import { db } from '$lib/db'
import { user } from '$lib/db/schema'
import { eq } from 'drizzle-orm'
import { syncUserRatelimitWithDB } from '$lib/ratelimit'

const app = new Hono()

app.use('*', cors({ origin: '*' }))

app.post(
	'/polar',
	Webhooks({
		webhookSecret: Bun.env.POLAR_WEBHOOK_SECRET!,
		onSubscriptionRevoked: async (payload) => {
			if (
				payload.data.priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID ||
				payload.data.priceId === Bun.env.POLAR_BASIC_PLAN_PRICE_ID
			) {
				const customerId = payload.data.customerId

				if (!customerId) return

				await db
					.update(user)
					.set({
						plan: 'free',
						searchLimit: 0,
						premiumChatLimit: 0,
						standardChatLimit: 0,
					})
					.where(eq(user.polarCustomerId, customerId))

				const customer_user = await db.query.user.findFirst({
					where: (user, { eq }) =>
						eq(user.polarCustomerId, customerId),
				})

				if (!customer_user) return

				await syncUserRatelimitWithDB(customer_user.id)
			}
		},
		onOrderCreated: async (payload) => {
			console.log('hit')
			if (
				payload.data.billingReason === 'subscription_cycle' ||
				payload.data.billingReason === 'subscription_create'
			) {
				const priceId = payload.data.productPriceId
				if (
					priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID ||
					priceId === Bun.env.POLAR_BASIC_PLAN_PRICE_ID
				) {
					const customerId = payload.data.customerId

					if (!customerId) return

					const customer_user = await db.query.user.findFirst({
						where: (user, { eq }) =>
							eq(user.polarCustomerId, customerId),
					})

					if (!customer_user) return

					await db
						.update(user)
						.set({
							plan:
								priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID
									? 'pro'
									: 'basic',
							standardChatLimit:
								priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID
									? 3000
									: 1000,
							premiumChatLimit:
								priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID ? 200 : 0,
							searchLimit:
								priceId === Bun.env.POLAR_PRO_PLAN_PRICE_ID
									? 400
									: 100,
						})
						.where(eq(user.polarCustomerId, customerId))

					await syncUserRatelimitWithDB(customer_user.id)
				}
			} else if (payload.data.billingReason === 'purchase') {
				// const priceId = payload.data.productPriceId
				// if (priceId === Bun.env.PRIVATE_POLAR_500_CREDIT_PRICE_ID) {
				// 	const customerId = payload.data.customerId
				// 	if (!customerId) return
				// 	const customer_user = await db.query.user.findFirst({
				// 		where: (user, { eq }) =>
				// 			eq(user.polarCustomerId, customerId),
				// 	})
				// 	if (!customer_user) return
				// 	await db
				// 		.update(user)
				// 		.set({
				// 			plan: 'pro',
				// 			credit: customer_user.credit + 500,
				// 		})
				// 		.where(eq(user.polarCustomerId, customerId))
				// }
			}
		},
	}),
)

export default app
