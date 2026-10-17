import createClient from 'openapi-fetch';
import type { components, paths } from './schema.js';

// Typed client for one rgb-lightning-node REST API (motore `rln-rest`, SPEC §14.0), generated
// from docs/vendor/rln-openapi.yaml (RGB-Tools/rgb-lightning-node@d4762ac). Regenerate with
// `pnpm rln:gen`. Never call /signmessage: in d4762ac it signs the empty string (SPEC §9.1).
export type RlnPaths = paths;
export type RlnSchemas = components['schemas'];

export interface RlnClientOptions {
  /** Injected in unit tests; defaults to the global fetch. */
  fetch?: (input: Request) => Promise<Response>;
}

export function createRlnClient(baseUrl: string, opts: RlnClientOptions = {}) {
  return createClient<paths>(opts.fetch ? { baseUrl, fetch: opts.fetch } : { baseUrl });
}

export type RlnClient = ReturnType<typeof createRlnClient>;

export { RlnError, isRlnErrorBody, toRlnError, type RlnErrorBody } from './errors.js';
