import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentClient, MEMBER_IDS, type ActorId, type AgentClient } from '@kitty/shared';

// E2E ONLY (pnpm e2e:*): a relay and the agents as child processes, on their own ports and a
// fresh relay database, so the run never touches the relay of `pnpm dev`. The agents are the
// real ones (index.ts, KITTY_FAKES=0) on the regtest stack seeded by `pnpm demo:reset`.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const ESPLORA = (process.env.ESPLORA_URL ?? 'http://127.0.0.1:3010').replace(/\/+$/u, '');

export interface Stack {
  relayUrl: string;
  agentUrl: string;
  client: (as: ActorId) => AgentClient;
  stop: () => Promise<void>;
}

/** A child process stopped: waiting longer cannot help. */
class StackDied extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  what: string,
  f: () => Promise<T | undefined>,
  ms = 60_000,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await f();
      if (v !== undefined) return v;
    } catch (e) {
      if (e instanceof StackDied) throw e;
      last = e;
    }
    if (Date.now() > end)
      throw new Error(`timeout (${ms} ms) waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await sleep(everyMs);
  }
}

export async function tipHeight(): Promise<number> {
  const res = await fetch(`${ESPLORA}/blocks/tip/height`);
  if (!res.ok) throw new Error(`esplora /blocks/tip/height: HTTP ${res.status}`);
  return Number.parseInt(await res.text(), 10);
}

/** `pnpm start` of an app: its own tsx, from its own directory. */
function start(
  name: 'relay' | 'agent',
  env: Record<string, string>,
  out: WriteStream,
): ChildProcess {
  const cwd = join(repoRoot, 'apps', name);
  const child = spawn(join(cwd, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd,
    env: { ...process.env, ...env, KITTY_FAKES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (chunk: Buffer) =>
    out.write(
      chunk
        .toString()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => `[${name}] ${l}\n`)
        .join(''),
    );
  child.on('error', (e) => out.write(`[${name}] spawn failed: ${e.message}\n`));
  child.stdout?.on('data', tag);
  child.stderr?.on('data', tag);
  return child;
}

async function stopChild(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>((r) => c.once('exit', () => r()));
  c.kill('SIGTERM');
  await Promise.race([exited, sleep(5_000)]);
  if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
}

/**
 * Starts relay and agents, then waits until the trip of the seed is on the relay with the
 * three travelers active (SPEC §6.1-6.2). `processLog` receives the children's output.
 */
export async function startStack(p: {
  relayPort: number;
  agentPort: number;
  processLog: string;
  env?: Record<string, string>;
}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-e2e-'));
  const out = createWriteStream(p.processLog, { flags: 'a' });
  const relayUrl = `http://127.0.0.1:${p.relayPort}`;
  const agentUrl = `http://127.0.0.1:${p.agentPort}`;
  const relay = start(
    'relay',
    { RELAY_PORT: String(p.relayPort), RELAY_DB: join(dir, 'relay.sqlite') },
    out,
  );
  const agent = start(
    'agent',
    {
      AGENT_PORT: String(p.agentPort),
      RELAY_URL: relayUrl,
      ...p.env,
      // The e2e assertions assume the test timers (DEMO_TRIP_PARAMS), not the live demo's 45/120 s:
      // pinned after the shell env and p.env, so neither can override them.
      SILENT_ASSENT_SECONDS: '20',
      PAYMENT_DEADLINE_SECONDS: '30',
    },
    out,
  );
  const stop = async () => {
    await stopChild(agent);
    await stopChild(relay);
    await new Promise<void>((r) => out.end(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  const client = (as: ActorId) => createAgentClient(agentUrl, as);

  const exited = () =>
    agent.exitCode !== null || agent.signalCode !== null || agent.pid === undefined
      ? 'agent'
      : relay.exitCode !== null || relay.signalCode !== null || relay.pid === undefined
        ? 'relay'
        : null;
  try {
    await waitFor(
      'the trip of the seed with alice, bob and charlie active',
      async () => {
        const dead = exited();
        if (dead !== null) throw new StackDied(`the ${dead} stopped: see ${p.processLog}`);
        const s = await client('dave').getState();
        const active = s.members.filter((m) => m.status === 'active').map((m) => m.memberId);
        return MEMBER_IDS.every((id) => active.includes(id)) ? s : undefined;
      },
      90_000,
      1_000,
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return { relayUrl, agentUrl, client, stop };
}
