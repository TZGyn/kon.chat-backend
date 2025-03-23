import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'

// For extending the Zod schema with OpenAPI properties
import 'zod-openapi/extend'
import { openAPISpecs } from 'hono-openapi'
import { apiReference } from '@scalar/hono-api-reference'

import AuthRoutes from './routes/auth'
import ChatRoutes from './routes/chat'
import FileUploadRoutes from './routes/file-upload'
import WebhookRoutes from './routes/webhook'
import BillingRoutes from './routes/billing'
import DocumentsRoutes from './routes/document'
import YoutubeRoutes from './routes/youtube'
import VersionRoutes from './routes/version'

const app = new Hono()
app.use(cors({ origin: [Bun.env.FRONTEND_URL!], credentials: true }))
app.use(logger())

app.get('/', (c) => {
	return c.redirect(Bun.env.FRONTEND_URL!)
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

app.route('/auth', AuthRoutes)
app.route('/chat', ChatRoutes)
app.route('/file-upload', FileUploadRoutes)
app.route('/webhook', WebhookRoutes)
app.route('/billing', BillingRoutes)
app.route('/documents', DocumentsRoutes)
app.route('/youtube', YoutubeRoutes)
app.route('/version', VersionRoutes)

export default {
	fetch: app.fetch,
	hostname: '0.0.0.0',
	port: 3000,
	idleTimeout: 0,
}
