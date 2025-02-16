import { Hono } from 'hono'
import { Checkout, CustomerPortal } from '@polar-sh/hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { getCookie } from 'hono/cookie'

// For extending the Zod schema with OpenAPI properties
import 'zod-openapi/extend'
import { openAPISpecs } from 'hono-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import {
	deleteSessionTokenCookie,
	setSessionTokenCookie,
	validateSessionToken,
} from '../lib/auth/session'

import AuthRoutes from './routes/auth'
import ChatRoutes from './routes/chat'
import WebhookRoutes from './routes/webhook'
import BillingRoutes from './routes/billing'

const app = new Hono()
app.use(
	cors({ origin: ['http://localhost:5173'], credentials: true }),
)
app.use(logger())

app.get('/', (c) => {
	return c.text('Hello Hono!')
})

app.get(
	'/openapi',
	openAPISpecs(app, {
		documentation: {
			info: {
				title: 'Hono',
				version: '1.0.0',
				description: 'API for greeting users',
			},
			servers: [
				{
					url: 'http://localhost:3000',
					description: 'Local server',
				},
			],
		},
	}),
)

app.get(
	'/docs',
	apiReference({
		theme: 'saturn',
		spec: {
			url: '/openapi',
		},
	}),
)

app.get(
	'/checkout',
	Checkout({
		accessToken: Bun.env.POLAR_ACCESS_KEY, // Or set an environment variable to POLAR_ACCESS_TOKEN
		successUrl: Bun.env.SUCCESS_URL,
		server:
			Bun.env.APP_ENV === 'production' ? 'production' : 'sandbox', // Use sandbox if you're testing Polar - omit the parameter or pass 'production' otherwise
	}),
)

app.get(
	'/portal',
	CustomerPortal({
		accessToken: 'xxx', // Or set an environment variable to POLAR_ACCESS_TOKEN
		getCustomerId: async (event) => {
			const token = getCookie(event, 'session') ?? null

			if (token === null) {
				return ''
			}
			const { session, user } = await validateSessionToken(token)

			if (!user) {
				return ''
			}

			if (session !== null) {
				setSessionTokenCookie(event, token, session.expiresAt)
			} else {
				deleteSessionTokenCookie(event)
			}

			return user.polarCustomerId || ''
		}, // Function to resolve a Polar Customer ID
		server: 'sandbox', // Use sandbox if you're testing Polar - omit the parameter or pass 'production' otherwise
	}),
)

app.route('/auth', AuthRoutes)
app.route('/chat', ChatRoutes)
app.route('/webhook', WebhookRoutes)
app.route('/billing', BillingRoutes)

Bun.serve({
	...app,
	hostname: '0.0.0.0',
	idleTimeout: 255,
})
