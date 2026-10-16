import { buildRelay } from './server.js';

const host = process.env.RELAY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.RELAY_PORT ?? '4000', 10);

await buildRelay().listen({ host, port });
