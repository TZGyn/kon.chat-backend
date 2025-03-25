import { Hono } from 'hono'
import ImagenRoutes from './image/imagen'

const app = new Hono()

app.route('/imagen', ImagenRoutes)

export default app
