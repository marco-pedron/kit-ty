import createClient from 'openapi-fetch';
import type { components, paths } from './schema.js';

// Typed client for one rgb-lightning-node REST API (motore `rln-rest`, SPEC §14.0), generated
// from docs/vendor/rln-openapi.yaml (RGB-Tools/rgb-lightning-node@d4762ac). Regenerate with
// `pnpm rln:gen`. Never call /signmessage: in d4762ac it signs the empty string (SPEC §9.1).
export type RlnPaths = paths;
export type RlnSchemas = components['schemas'];

export function createRlnClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

export type RlnClient = ReturnType<typeof createRlnClient>;
