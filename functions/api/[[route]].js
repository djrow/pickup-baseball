import { handle } from 'hono/cloudflare-pages';
import { app } from '../../src/app/index.js';

export const onRequest = handle(app);
