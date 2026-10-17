import {
  ApiClientError,
  formatCents,
  type Receipt,
  type SplitAssignment,
  type SplitPreview,
} from '@kitty/shared';
import { useRef, useState, type ReactNode } from 'react';
import { ErrorBox, Money, ScreenHeader } from '../components.js';
import { formatMinor, parseMinor, receiptGap, withItemTotal } from '../receipt-edit.js';
import { toClientError, useNow } from '../state.js';
import type { ScreenProps } from './types.js';

// New expense (SPEC §6.3): photo of the receipt → the on-device AI reads it → the payer fixes
// the rows → one sentence says who had what → the ledger computes the parts → send. The AI
// proposes, the ledger computes: parts come only from `preview`, never from the model.

interface Photo {
  url: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataBase64: string;
  sha256: string;
}

type Step = 'pick' | 'reading' | 'review' | 'splitting' | 'sending' | 'sent';

const MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

async function readPhoto(file: File): Promise<Photo> {
  const mimeType = MIME.find((m) => m === file.type);
  if (mimeType === undefined)
    throw new ApiClientError(
      'VALIDATION_ERROR',
      `This file is not a photo kit+ty can read (${file.type || 'unknown type'}).`,
      'Choose a JPEG, PNG or WebP photo of the receipt.',
      0,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return {
    url: URL.createObjectURL(file),
    mimeType,
    dataBase64: btoa(bin),
    sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

export function NewExpenseScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [startedAt, setStartedAt] = useState(0);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sentence, setSentence] = useState('');
  const [assignments, setAssignments] = useState<SplitAssignment[] | null>(null);
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<ApiClientError | null>(null);

  const me = s?.members.find((m) => m.memberId === as);
  const blocked =
    s?.trip == null
      ? 'Waiting for dave to set up the trip.'
      : me?.status === 'excluded'
        ? 'You were excluded from this trip: you cannot add expenses.'
        : me?.status !== 'active'
          ? 'Your channels are not open yet: you can add expenses once they are.'
          : null;

  const fail = (e: unknown, back: Step) => {
    setError(toClientError(e));
    setStep(back);
  };
  const begin = (next: Step) => {
    setError(null);
    setStartedAt(Date.now());
    setStep(next);
  };

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    begin('reading');
    setReceipt(null);
    setAssignments(null);
    setPreview(null);
    try {
      const p = await readPhoto(file);
      setPhoto(p);
      const r = await trip.client.extractReceipt({
        image: { mimeType: p.mimeType, dataBase64: p.dataBase64 },
      });
      if (!r.ok)
        throw new ApiClientError(
          'VALIDATION_ERROR',
          `The AI could not read the receipt: ${r.error}`,
          'Retake the photo, flat and well lit.',
          0,
        );
      setReceipt(r.data);
      setStep('review');
    } catch (e) {
      fail(e, 'pick');
    }
  };

  const split = async (clarification?: { question: string; answer: string }) => {
    if (receipt === null) return;
    begin('splitting');
    setAssignments(null);
    setPreview(null);
    setNote(null);
    try {
      const { result, preview: pv } = await trip.client.proposeSplit({
        receipt,
        text: sentence,
        ...(clarification !== undefined && { clarification }),
      });
      setQuestion(null);
      if (!result.ok) {
        setNote(`The AI could not split it: ${result.error}. Try a clearer sentence.`);
      } else if (result.data.clarificationNeeded !== undefined && clarification === undefined) {
        setQuestion(result.data.clarificationNeeded);
      } else if (result.data.unassigned.length > 0) {
        const names = result.data.unassigned.map((i) => receipt.items[i]?.label ?? `#${i}`);
        setNote(`Nobody is assigned to: ${names.join(', ')}. Say who had them.`);
      } else if (pv === null) {
        setNote('The ledger could not compute the parts. Check the rows and the sentence.');
      } else {
        setAssignments(result.data.assignments);
        setPreview(pv);
      }
      setStep('review');
    } catch (e) {
      fail(e, 'review');
    }
  };

  const send = async () => {
    if (receipt === null || assignments === null || photo === null) return;
    begin('sending');
    try {
      await trip.client.submitExpense({
        receipt,
        assignments,
        receiptImageSha256: photo.sha256,
      });
      trip.refresh();
      setStep('sent');
      setTimeout(() => go('home'), 1500);
    } catch (e) {
      fail(e, 'review');
    }
  };

  const edit = (r: Receipt) => {
    setReceipt(r);
    setAssignments(null);
    setPreview(null);
  };

  return (
    <>
      <ScreenHeader title="New expense" back="home" go={go} />
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="space-y-4 px-4" data-noswipe={step !== 'pick' ? '' : undefined}>
        {s?.ai && (
          <p className="text-xs text-gray-500">
            {s.ai.fake ? 'Simulated AI (fakes on)' : 'AI runs on this device'} ·{' '}
            {s.ai.status === 'ready' ? 'ready' : s.ai.status === 'loading' ? 'loading…' : 'error'}
          </p>
        )}
        {error && <ErrorBox error={error} />}

        {step === 'pick' && <Pick blocked={blocked} onCamera={() => fileInput.current?.click()} />}
        {step === 'reading' && (
          <Waiting since={startedAt}>Reading the receipt on this device…</Waiting>
        )}

        {receipt !== null && step !== 'reading' && (
          <>
            {photo && (
              <img
                src={photo.url}
                alt="Your receipt"
                className="max-h-40 rounded-xl object-contain shadow-sm"
              />
            )}
            <ReceiptEditor receipt={receipt} onChange={edit} disabled={step !== 'review'} />

            <section className="space-y-2">
              <label htmlFor="who" className="block text-sm font-medium">
                Who had what?
              </label>
              <textarea
                id="who"
                rows={2}
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                placeholder="Bob and I had the pho, Charlie only beers, water for all three"
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void split()}
                disabled={sentence.trim() === '' || step !== 'review'}
                className="w-full rounded-full border border-pink-600 py-2 text-sm font-semibold text-pink-700 disabled:opacity-40"
              >
                Split with AI
              </button>
              {step === 'splitting' && (
                <Waiting since={startedAt}>Splitting on this device…</Waiting>
              )}
              {note && <p className="text-sm text-amber-800">{note}</p>}
              {question && (
                <form
                  className="space-y-2 rounded-xl bg-amber-50 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void split({ question, answer });
                  }}
                >
                  <p className="text-sm">{question}</p>
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button type="submit" className="text-sm font-semibold text-pink-700">
                    Answer
                  </button>
                </form>
              )}
            </section>

            {preview && assignments && (
              <Parts receipt={receipt} assignments={assignments} preview={preview} me={as} />
            )}

            {step === 'sending' && (
              <Waiting since={startedAt}>Creating payment requests and signing…</Waiting>
            )}
            {step === 'sent' ? (
              <p className="rounded-xl bg-green-50 p-3 text-sm text-green-900">
                Sent: the payment requests are signed by your node.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={preview === null || step !== 'review' || blocked !== null}
                className="w-full rounded-full bg-pink-600 py-3 font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Pick({ blocked, onCamera }: { blocked: string | null; onCamera: () => void }) {
  return (
    <div className="flex min-h-[55dvh] flex-col items-center justify-end gap-3">
      <p className="text-center text-sm text-gray-500">
        {blocked ?? 'Take a photo of the receipt. It never leaves this phone.'}
      </p>
      <div className="flex overflow-hidden rounded-full border border-gray-300 bg-white shadow-sm">
        <button
          type="button"
          onClick={onCamera}
          disabled={blocked !== null}
          aria-label="Photo of the receipt"
          className="px-8 py-3 text-2xl disabled:opacity-40"
        >
          📷
        </button>
        <span className="w-px bg-gray-300" />
        <button
          type="button"
          disabled
          aria-label="Voice, coming soon"
          className="flex items-center gap-1 px-8 py-3 text-2xl opacity-40"
        >
          🎤<span className="text-xs font-medium">soon</span>
        </button>
      </div>
    </div>
  );
}

function Waiting({ since, children }: { since: number; children: ReactNode }) {
  const now = useNow(500);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <p className="flex items-center gap-2 text-sm text-gray-600" role="status">
      <span className="size-3 animate-spin rounded-full border-2 border-pink-600 border-t-transparent" />
      {children} <span className="tabular-nums">{s} s</span>
    </p>
  );
}

function ReceiptEditor({
  receipt: r,
  onChange,
  disabled,
}: {
  receipt: Receipt;
  onChange: (r: Receipt) => void;
  disabled: boolean;
}) {
  const gap = receiptGap(r);
  const extra = (key: 'tax' | 'tip', label: string) =>
    r[key] !== undefined && (
      <div className="flex justify-between text-gray-600">
        <span>{label}</span>
        <AmountInput
          value={r[key]}
          currency={r.currency}
          disabled={disabled}
          onChange={(v) => onChange({ ...r, [key]: v })}
        />
      </div>
    );
  return (
    <section className="space-y-2 rounded-2xl bg-white p-3 text-sm shadow-sm">
      <input
        value={r.merchant}
        disabled={disabled}
        onChange={(e) => onChange({ ...r, merchant: e.target.value })}
        aria-label="Merchant"
        className="w-full rounded-lg px-1 font-semibold"
      />
      <p className="px-1 text-xs text-gray-500">
        {r.date} · {r.currency}
      </p>
      <ul className="space-y-1">
        {r.items.map((it, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              value={it.label}
              disabled={disabled}
              aria-label={`Item ${i + 1}`}
              onChange={(e) =>
                onChange({
                  ...r,
                  items: r.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                })
              }
              className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1"
            />
            <AmountInput
              value={it.total}
              currency={r.currency}
              disabled={disabled}
              onChange={(v) => onChange(withItemTotal(r, i, v))}
            />
          </li>
        ))}
      </ul>
      {extra('tax', 'Tax')}
      {extra('tip', 'Tip')}
      <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold">
        <span>Total</span>
        <AmountInput
          value={r.total}
          currency={r.currency}
          disabled={disabled}
          onChange={(v) => v > 0n && onChange({ ...r, total: v })}
        />
      </div>
      {gap !== 0n && (
        <p className="text-xs text-red-700">
          The rows {gap > 0n ? 'exceed' : 'are short of'} the total by{' '}
          {formatMinor(gap > 0n ? gap : -gap, r.currency)} {r.currency}. Fix an item or the total.
        </p>
      )}
      {r.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-800">
          {w}
        </p>
      ))}
    </section>
  );
}

/** Text while typing, bigint once valid: an invalid entry is shown, never sent. */
function AmountInput({
  value,
  currency,
  disabled,
  onChange,
}: {
  value: bigint;
  currency: Receipt['currency'];
  disabled: boolean;
  onChange: (v: bigint) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatMinor(value, currency);
  const invalid = text !== null && parseMinor(text, currency) === null;
  return (
    <input
      inputMode="decimal"
      value={shown}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = text === null ? null : parseMinor(text, currency);
        if (v !== null) onChange(v);
        setText(null);
      }}
      className={`w-24 rounded-lg border px-2 py-1 text-right tabular-nums ${invalid ? 'border-red-500' : 'border-gray-200'}`}
    />
  );
}

function Parts({
  receipt,
  assignments,
  preview,
  me,
}: {
  receipt: Receipt;
  assignments: SplitAssignment[];
  preview: SplitPreview;
  me: string;
}) {
  return (
    <section className="space-y-2 rounded-2xl bg-white p-3 text-sm shadow-sm">
      <ul className="space-y-1 text-xs text-gray-600">
        {assignments.map((a) => (
          <li key={a.itemIndex}>
            {receipt.items[a.itemIndex]?.label}: {a.members.join(', ')}
          </li>
        ))}
      </ul>
      <ul className="space-y-1 border-t border-gray-100 pt-2">
        {preview.shares.map((sh) => (
          <li key={sh.member} className="flex justify-between">
            <span>{sh.member === me ? 'Your part' : `${sh.member}'s part`}</span>
            <Money cents={sh.cents} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500">
        Total {formatCents(preview.totalUsdCents)} DUSD at {preview.rate} {receipt.currency} per USD
        ({preview.rateAsOf}). Parts are computed by the ledger, not the AI.
      </p>
    </section>
  );
}
