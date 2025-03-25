import { Hono } from 'hono'
import { s3Client } from '$lib/s3'
import { db } from '$lib/db'

const app = new Hono()

app.get('/:upload_id', async (c) => {
	const upload_id = c.req.param('upload_id')
	const uploadContent = await db.query.upload.findFirst({
		where: (upload, t) => t.eq(upload.id, upload_id),
	})

	if (!uploadContent) {
		return c.text('', { status: 404 })
	}

	const s3file = s3Client.file(uploadContent.key)

	return c.newResponse(s3file.stream())
})

export default app
