import { loadConfig } from './config.js';
import { buildAgentServer } from './server.js';

const config = loadConfig();
await buildAgentServer(config).listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
