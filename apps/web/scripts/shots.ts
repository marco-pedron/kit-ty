// Screenshots of the traveler app in WebKit (Safari's engine), 390×844, light and dark, into
// apps/web/.shots/ (gitignored). Needs the stack with fakes on a clean relay:
//   rm -f apps/relay/data/relay.sqlite* && pnpm dev:fakes
//   pnpm --filter @kitty/web shots [name-filter…]
// It creates an expense through the agent API (alice pays dinner; charlie set to "Always ask")
// so that approval cards, the dispute sheet and the +ty toast exist.
import { readFileSync, mkdirSync } from 'node:fs';
import { webkit } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE = process.env['SHOTS_URL'] ?? 'http://127.0.0.1:5173';
const OUT = new URL('../.shots/', import.meta.url).pathname;
const FIXTURE = new URL('../../../infra/fixtures/receipts/vnd-dinner.png', import.meta.url)
  .pathname;
const filters = process.argv.slice(2);
const USERS = ['alice', 'bob', 'charlie'] as const;
const SCREENS = ['home', 'new', 'qr', 'groups', 'group', 'profile'] as const;

const wanted = (name: string) => filters.length === 0 || filters.some((f) => name.includes(f));
const settle = (page: Page) => page.waitForTimeout(700);

async function api(path: string, init?: { method: string; body: unknown }) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init && { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const DINNER = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: '65000', total: '130000' },
    { label: 'Bia Saigon x3', quantity: 3, unitPrice: '25000', total: '75000' },
    { label: 'Water', quantity: 3, unitPrice: '10000', total: '30000' },
  ],
  subtotal: '235000',
  tip: '20000',
  total: '255000',
  warnings: [],
};
const SPLIT = [
  { itemIndex: 0, members: ['alice', 'bob'] },
  { itemIndex: 1, members: ['charlie'] },
  { itemIndex: 2, members: ['alice', 'bob', 'charlie'] },
];

async function seedExpense() {
  const hash = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await api('alice/expenses', {
    method: 'POST',
    body: { receipt: DINNER, assignments: SPLIT, receiptImageSha256: hash },
  });
}

async function shot(page: Page, name: string, scheme: string) {
  if (!wanted(name)) return;
  await settle(page);
  await page.screenshot({ path: `${OUT}${name}-${scheme}.png` });
  console.log(`  ${name}-${scheme}.png`);
}

async function open(browser: Browser, scheme: 'light' | 'dark', who: string, hash = '') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?as=${who}${hash}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return page;
}

async function run(browser: Browser, scheme: 'light' | 'dark') {
  console.log(`${scheme}:`);
  const alice = await open(browser, scheme, 'alice');
  const bob = await open(browser, scheme, 'bob');
  const charlie = await open(browser, scheme, 'charlie');

  // Live moments first: the cards last 20-30 s, the toast 3 s.
  const toast = alice.getByText('+ty!').first().waitFor({ timeout: 90_000 });
  await seedExpense();
  await bob.getByRole('button', { name: 'Approve' }).first().waitFor({ timeout: 15_000 });
  await shot(bob, 'bob-card', scheme);
  await charlie.getByRole('button', { name: 'Approve' }).first().waitFor({ timeout: 15_000 });
  await shot(charlie, 'charlie-card', scheme);
  if (wanted('charlie-dispute')) {
    await charlie.getByRole('button', { name: 'Dispute' }).first().click();
    await charlie.getByRole('dialog').waitFor();
    await charlie.getByRole('textbox').fill('I only had water');
    await shot(charlie, 'charlie-dispute', scheme);
    await charlie.keyboard.press('Escape');
  }
  await toast.catch(() => console.log('  (no +ty toast seen)'));
  await shot(alice, 'alice-toast', scheme);

  for (const who of USERS) {
    const page = who === 'alice' ? alice : who === 'bob' ? bob : charlie;
    for (const s of SCREENS) {
      if (!wanted(`${who}-${s}`)) continue;
      await page.goto(`${BASE}/?as=${who}${s === 'home' ? '' : `#/${s}`}`);
      await shot(page, `${who}-${s}`, scheme);
    }
  }

  // New expense: reading (the kitten waves) and check (rows, split, parts).
  if (wanted('alice-reading') || wanted('alice-check')) {
    await alice.goto(`${BASE}/?as=alice#/new`);
    await alice.getByTestId('receipt-file').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: readFileSync(FIXTURE),
    });
    await shot(alice, 'alice-reading', scheme);
    await alice.getByText('Check the receipt').first().waitFor({ timeout: 30_000 });
    await alice
      .getByLabel('Who had what?')
      .fill('Bob and I had the pho, Charlie only beers, water for all three');
    await alice.getByRole('button', { name: 'Split with AI' }).click();
    await alice.getByText('Parts', { exact: true }).waitFor({ timeout: 30_000 });
    await shot(alice, 'alice-check', scheme);
  }

  const guide = await open(browser, scheme, 'styleguide');
  await shot(guide, 'styleguide', scheme);
  await guide.screenshot({ path: `${OUT}styleguide-full-${scheme}.png`, fullPage: true });
  await guide.context().close();
  for (const p of [alice, bob, charlie]) await p.context().close();
}

mkdirSync(OUT, { recursive: true });
// Charlie asks for every part: his card waits for him instead of paying in 20 s.
await api('charlie/policy', {
  method: 'PUT',
  body: { policy: { autoPayLimitCents: '0', dailyCapCents: '6000', payUpheldDisputes: false } },
});
const browser = await webkit.launch();
try {
  for (const scheme of ['light', 'dark'] as const) await run(browser, scheme);
} finally {
  await browser.close();
}
