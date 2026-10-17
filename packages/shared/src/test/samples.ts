import type { Receipt, TripView } from '../index.js';
import { DEFAULT_POLICY, DEMO_TRIP_PARAMS } from '../index.js';

export const HASH = (c: string) => c.repeat(64).slice(0, 64);
export const NODE = (c: string) => `02${c.repeat(64).slice(0, 64)}`;
export const AT = '2026-10-17T12:00:00.000Z';

// The demo dinner (SPEC §15): 255,000 VND, shares 3.09 / 3.09 / 3.50.
export const dinner: Receipt = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    { label: 'Bia Saigon x3', quantity: 3, unitPrice: 25_000n, total: 75_000n },
    { label: 'Water', quantity: 3, unitPrice: 10_000n, total: 30_000n },
  ],
  subtotal: 235_000n,
  tip: 20_000n,
  total: 255_000n,
  warnings: [],
};

export const emptyState: TripView = {
  as: 'bob',
  role: 'traveler',
  fakes: true,
  serverNow: AT,
  trip: {
    tripId: 'vietnam-2026',
    name: 'Vietnam 2026',
    assetId: 'rgb:dusd',
    status: 'open',
    params: DEMO_TRIP_PARAMS,
  },
  rate: { asOf: '2026-10-17', source: 'infra/rates.json', rates: { VND: '26350' } },
  members: [],
  me: {
    memberId: 'bob',
    policy: DEFAULT_POLICY,
    balance: {
      tripOutboundCents: 5000n,
      inboundCents: 3000n,
      onchainCents: 5000n,
      tripChannelCents: 5000n,
      topupWarning: false,
    },
    oweCents: 309n,
    owedToMeCents: 0n,
    autoPaidTodayCents: 0n,
    debts: [
      {
        expenseId: 'e1',
        expenseEventHash: HASH('a'),
        payer: 'alice',
        debtor: 'bob',
        cents: 309n,
        itemIndexes: [0, 2],
        state: 'awaiting_decision',
        seenAt: AT,
        deadlineAt: '2026-10-17T12:00:20.000Z',
        contestReason: null,
        resolution: null,
        agent: { pay: true, reason: 'Will pay 3.09 to alice at the end of silent assent.' },
        paidBy: null,
        proof: null,
        invoiceExpiresAt: '2026-10-17T13:00:00.000Z',
      },
    ],
    credits: [],
  },
  coordinator: null,
  expenses: [],
  activity: [],
  operations: [],
  ai: { status: 'ready', fake: true },
  ledger: {
    events: 0,
    validSignatures: 0,
    chainValid: true,
    headSeq: 0,
    headHash: null,
    checkpoints: null,
  },
  explorerBaseUrl: 'http://127.0.0.1:3010',
};
