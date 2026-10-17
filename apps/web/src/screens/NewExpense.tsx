import {
  ApiClientError,
  formatCents,
  type Receipt,
  type SplitAssignment,
  type SplitPreview,
} from '@kitty/shared';
import { useRef, useState } from 'react';
import { ErrorBox, Money, ScreenHeader } from '../components.js';
import { formatMinor, parseMinor, receiptGap, withItemTotal } from '../receipt-edit.js';
import { Loading } from '../Mascot.js';
import { toClientError } from '../state.js';
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
          <p className="text-small text-ink-muted">
            {s.ai.fake ? 'Simulated AI (fakes on)' : 'AI runs on this device'} ·{' '}
            {s.ai.status === 'ready' ? 'ready' : s.ai.status === 'loading' ? 'loading…' : 'error'}
          </p>
        )}
        {error && <ErrorBox error={error} />}

        {step === 'pick' && <Pick blocked={blocked} onCamera={() => fileInput.current?.click()} />}
        {step === 'reading' && (
          <Loading since={startedAt}>Reading the receipt on your phone…</Loading>
        )}

        {receipt !== null && step !== 'reading' && (
          <>
            {photo && (
              <img
                src={photo.url}
                alt="Your receipt"
                className="max-h-40 rounded-[16px] border-[1.5px] border-line object-contain"
              />
            )}
            <ReceiptEditor receipt={receipt} onChange={edit} disabled={step !== 'review'} />

            <section className="space-y-2">
              <label htmlFor="who" className="block font-semibold">
                Who had what?
              </label>
              <textarea
                id="who"
                rows={2}
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                placeholder="Bob and I had the pho, Charlie only beers, water for all three"
                className="field w-full"
              />
              <button
                type="button"
                onClick={() => void split()}
                disabled={sentence.trim() === '' || step !== 'review'}
                className="btn btn-secondary w-full"
              >
                Split with AI
              </button>
              {step === 'splitting' && (
                <Loading since={startedAt} size={48}>
                  Splitting on your phone…
                </Loading>
              )}
              {note && <p className="card-attention py-3">{note}</p>}
              {question && (
                <form
                  className="card-attention space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void split({ question, answer });
                  }}
                >
                  <p>{question}</p>
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    required
                    className="field w-full"
                  />
                  <button type="submit" className="btn btn-primary">
                    Answer
                  </button>
                </form>
              )}
            </section>

            {preview && assignments && (
              <Parts receipt={receipt} assignments={assignments} preview={preview} me={as} />
            )}

            {step === 'sending' && (
              <Loading since={startedAt} size={48}>
                Creating payment requests and signing…
              </Loading>
            )}
            {step === 'sent' ? (
              <p className="card bg-mint-soft">
                Sent: the payment requests are signed by your node.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={preview === null || step !== 'review' || blocked !== null}
                className="btn btn-primary w-full py-3"
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
      <p className="text-center text-ink-muted">
        {blocked ?? 'Take a photo of the receipt. It never leaves this phone.'}
      </p>
      <div className="flex overflow-hidden rounded-full bg-plum">
        <button
          type="button"
          onClick={onCamera}
          disabled={blocked !== null}
          aria-label="Photo of the receipt"
          className="px-8 py-3 text-title text-surface disabled:text-ink-muted"
        >
          📷
        </button>
        <span className="w-[1.5px] bg-surface" />
        <button
          type="button"
          disabled
          aria-label="Voice, coming soon"
          className="flex items-center gap-1 px-8 py-3 text-title text-plum-soft"
        >
          🎤<span className="text-small font-semibold">soon</span>
        </button>
      </div>
    </div>
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
      <div className="flex items-center justify-between text-ink-muted">
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
    <section className="card space-y-2">
      <input
        value={r.merchant}
        disabled={disabled}
        onChange={(e) => onChange({ ...r, merchant: e.target.value })}
        aria-label="Merchant"
        className="field w-full font-slab text-amount font-bold"
      />
      <p className="px-1 text-small text-ink-muted">
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
              className="field min-w-0 flex-1 py-1"
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
      <div className="flex items-center justify-between border-t-[1.5px] border-line pt-2 font-semibold">
        <span>Total</span>
        <AmountInput
          value={r.total}
          currency={r.currency}
          disabled={disabled}
          onChange={(v) => v > 0n && onChange({ ...r, total: v })}
        />
      </div>
      {gap !== 0n && (
        <p className="card-attention py-2 text-small">
          The rows {gap > 0n ? 'exceed' : 'are short of'} the total by{' '}
          {formatMinor(gap > 0n ? gap : -gap, r.currency)} {r.currency}. Fix an item or the total.
        </p>
      )}
      {r.warnings.map((w) => (
        <p key={w} className="text-small text-ink">
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
      className="field amount w-28 py-1 text-right"
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
    <section className="card space-y-2">
      <ul className="space-y-1 text-small text-ink-muted">
        {assignments.map((a) => (
          <li key={a.itemIndex}>
            {receipt.items[a.itemIndex]?.label}: {a.members.join(', ')}
          </li>
        ))}
      </ul>
      <ul className="space-y-1 border-t-[1.5px] border-line pt-2">
        {preview.shares.map((sh) => (
          <li key={sh.member} className="flex justify-between">
            <span>{sh.member === me ? 'Your part' : `${sh.member}'s part`}</span>
            <Money cents={sh.cents} />
          </li>
        ))}
      </ul>
      <p className="text-small text-ink-muted">
        Total {formatCents(preview.totalUsdCents)} DUSD at {preview.rate} {receipt.currency} per USD
        ({preview.rateAsOf}). Parts are computed by the ledger, not the AI.
      </p>
    </section>
  );
}
