import { Hono } from 'hono'
import SheetRoutes from './document/sheet'

const app = new Hono()
app.route('/sheets', SheetRoutes)

export default app
