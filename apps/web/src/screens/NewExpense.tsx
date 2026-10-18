import {
  ApiClientError,
  formatCents,
  type Receipt,
  type SplitAssignment,
  type SplitPreview,
} from '@kitty/shared';
import { Camera, Mic, ScanLine, Sparkles } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { cap } from '../history.js';
import { formatMinor, parseMinor, receiptGap, withItemTotal } from '../receipt-edit.js';
import { toClientError, useNow } from '../state.js';
import { Badge } from '../ui/Badge.js';
import { NavBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Section } from '../ui/List.js';
import { Mascot } from '../ui/Mascot.js';
import { AiNote, ErrorNote } from '../ui/Notes.js';
import type { ScreenProps } from './types.js';
import { Working } from '../ui/PlusMinus.js';

// New expense (wireframe, story 1): 1 photo → 2 the AI reads it on the phone (the kitten waves)
// → 3 check the rows, say who had what, see the parts the ledger computed, send to the group.
// The AI proposes, the ledger computes: parts come only from `preview`.

interface Photo {
  url: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataBase64: string;
  sha256: string;
}

type Step = 'photo' | 'reading' | 'check';

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
  const [step, setStep] = useState<Step>('photo');
  const [startedAt, setStartedAt] = useState(0);
  const [readMs, setReadMs] = useState<number | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sentence, setSentence] = useState('');
  const [assignments, setAssignments] = useState<SplitAssignment[] | null>(null);
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<ApiClientError | null>(null);

  const me = s?.members.find((m) => m.memberId === as);
  const blocked =
    s?.trip == null
      ? 'Waiting for Dave to set up the trip.'
      : me?.status === 'excluded'
        ? 'You were excluded from this trip.'
        : me?.status !== 'active'
          ? 'Your channels are not open yet.'
          : null;

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setError(null);
    setReceipt(null);
    setAssignments(null);
    setPreview(null);
    setReadMs(null);
    const t0 = Date.now();
    setStartedAt(t0);
    setStep('reading');
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
      setReadMs(Date.now() - t0);
      setStep('check');
    } catch (e) {
      setError(toClientError(e));
      setStep('photo');
    }
  };

  const split = async (clarification?: { question: string; answer: string }) => {
    if (receipt === null) return;
    setSplitting(true);
    setError(null);
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
      if (!result.ok)
        setNote(`The AI could not split it: ${result.error}. Try a clearer sentence.`);
      else if (result.data.clarificationNeeded !== undefined && clarification === undefined)
        setQuestion(result.data.clarificationNeeded);
      else if (result.data.unassigned.length > 0)
        setNote(
          `Nobody is assigned to: ${result.data.unassigned.map((i) => receipt.items[i]?.label ?? `#${i}`).join(', ')}. Say who had them.`,
        );
      else if (pv === null)
        setNote('The ledger could not compute the parts. Check the rows and the sentence.');
      else {
        setAssignments(result.data.assignments);
        setPreview(pv);
      }
    } catch (e) {
      setError(toClientError(e));
    } finally {
      setSplitting(false);
    }
  };

  const send = async () => {
    if (receipt === null || assignments === null || photo === null) return;
    setSending(true);
    setError(null);
    try {
      await trip.client.submitExpense({ receipt, assignments, receiptImageSha256: photo.sha256 });
      trip.refresh();
      go('home');
    } catch (e) {
      setError(toClientError(e));
      setSending(false);
    }
  };

  const edit = (r: Receipt) => {
    setReceipt(r);
    setAssignments(null);
    setPreview(null);
  };

  if (step === 'reading')
    return (
      <>
        <NavBar title="New expense" back={{ label: 'Back', onClick: () => setStep('photo') }} />
        <ReadingView photo={photo} startedAt={startedAt} />
      </>
    );

  if (step === 'check' && receipt !== null)
    return (
      <>
        <NavBar
          title="Check the receipt"
          back={{ label: 'Back', onClick: () => setStep('photo') }}
        />
        <div className="space-y-6 px-4 pt-4" data-noswipe>
          {readMs !== null && (
            <p className="flex items-center justify-center gap-1.5 text-footnote text-label-2">
              <Sparkles size={13} strokeWidth={2} aria-hidden />
              Read on your phone in{' '}
              <span className="tabular font-semibold text-label">
                {(readMs / 1000).toFixed(1)} s
              </span>
            </p>
          )}
          <ReceiptEditor receipt={receipt} onChange={edit} disabled={splitting || sending} />

          <Section header="Split between">
            <div className="space-y-3 p-4">
              <label htmlFor="who" className="sr-only">
                Who had what?
              </label>
              <div className="relative">
                <textarea
                  id="who"
                  rows={3}
                  value={sentence}
                  onChange={(e) => setSentence(e.target.value)}
                  placeholder="Who had what? For example: taxi for all three"
                  className="block w-full resize-none rounded-control bg-bg-fill px-3 pt-2.5 pb-9 text-body placeholder:text-label-3"
                />
                {/* Voice input is not built yet: shown, disabled. */}
                <button
                  type="button"
                  disabled
                  aria-label="Dictate, coming soon"
                  className="absolute right-2 bottom-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-bg-cell px-2.5 text-caption font-semibold text-label-3"
                >
                  <Mic size={14} strokeWidth={2} aria-hidden />
                  <span aria-hidden className="h-3 w-px bg-separator" />
                  soon
                </button>
              </div>
              {assignments !== null && (
                <div className="flex flex-wrap gap-2">
                  {[...new Set(assignments.flatMap((a) => a.members))].map((m) => (
                    <Badge key={m} kind={m === as ? 'insolvent' : 'limit'}>
                      {cap(m)}
                    </Badge>
                  ))}
                </div>
              )}
              <Button
                variant="gray"
                full
                onClick={() => void split()}
                disabled={sentence.trim() === '' || splitting || sending}
              >
                {splitting ? <Working text="Splitting on your phone…" /> : 'Split with AI'}
              </Button>
              <AiNote />
              {note && <p className="text-subhead text-label">{note}</p>}
              {question && (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void split({ question, answer });
                  }}
                >
                  <p className="text-subhead font-semibold">{question}</p>
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    required
                    aria-label={question}
                    className="min-h-11 w-full rounded-control bg-bg-fill px-3 text-body"
                  />
                  <Button type="submit" variant="plain">
                    Answer
                  </Button>
                </form>
              )}
            </div>
          </Section>

          {preview !== null && (
            <Section
              header="Parts"
              footer={`${formatCents(preview.totalUsdCents)} DUSD at ${preview.rate} ${receipt.currency} per USD (${preview.rateAsOf}). Computed by the ledger, not the AI.`}
            >
              <ul>
                {preview.shares.map((sh, i) => (
                  <li
                    key={sh.member}
                    className={`ml-4 flex min-h-11 items-center justify-between pr-4 ${i < preview.shares.length - 1 ? 'hairline-b' : ''}`}
                  >
                    <span>{sh.member === as ? 'You' : cap(sh.member)}</span>
                    <span className="tabular font-semibold">
                      {formatCents(sh.cents)}
                      <span className="ml-1 text-footnote font-normal text-label-2">DUSD</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {error && <ErrorNote error={error} />}
          <Button
            full
            onClick={() => void send()}
            disabled={preview === null || sending || blocked !== null}
          >
            {sending ? <Working text="Signing and sending…" /> : 'Send to the group'}
          </Button>
        </div>
      </>
    );

  return (
    <>
      <NavBar title="New expense" back={{ label: 'Home', onClick: () => go('home') }} />
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        data-testid="receipt-file"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="flex flex-col items-center gap-4 px-4 pt-3">
        {s?.trip != null && <Badge kind="limit">{s.trip.name}</Badge>}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={blocked !== null}
          aria-label="Take a photo of the receipt"
          className="pressable flex aspect-[3/4] w-full max-w-72 flex-col items-center justify-center gap-3 rounded-card border border-dashed border-separator bg-bg-cell text-label-2 disabled:text-label-3"
        >
          <ScanLine size={48} strokeWidth={1.25} />
          <span className="text-subhead">{blocked ?? 'Tap to take a photo'}</span>
        </button>
        <p className="text-subhead text-label-2">
          Point at the receipt. The photo stays on your phone.
        </p>
        {error && <ErrorNote error={error} className="w-full" />}
        <div className="hairline flex rounded-full bg-bg-cell p-1">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={blocked !== null}
            aria-label="Camera"
            className="pressable grid h-11 w-16 place-items-center rounded-full text-accent-text disabled:text-label-3"
          >
            <Camera size={22} strokeWidth={1.75} />
          </button>
          <span className="my-2 w-px bg-separator" />
          <button
            type="button"
            disabled
            aria-label="Voice, coming soon"
            className="flex h-11 w-16 items-center justify-center gap-1 text-label-3"
          >
            <Mic size={22} strokeWidth={1.75} />
            <span className="text-caption">soon</span>
          </button>
        </div>
      </div>
    </>
  );
}

// While the AI reads (brief §5): the receipt first and biggest; the kitten small, lower; a
// playful phrase that changes every 3.5 s with the seconds in it and three breathing dots; then,
// quieter, what is actually happening.
const PHRASES = [
  'QVAC is doing its thing',
  'Kit is playing with yarn',
  'Kit is licking its fur',
  'Kit is purring',
  'Kit is chasing a laser',
  'Kit is stretching',
  'Kit is kneading the receipt',
  'Kit is counting the noodles',
  'Kit is sitting on the keyboard',
  'Kit is staring at the decimals',
] as const;
const PHRASE_MS = 3500;

function ReadingView({ photo, startedAt }: { photo: Photo | null; startedAt: number }) {
  const now = useNow(250);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const phrase = PHRASES[Math.floor((now - startedAt) / PHRASE_MS) % PHRASES.length] ?? PHRASES[0];
  return (
    <div className="flex flex-col items-center px-6 pt-4 text-center">
      {photo && (
        <img
          src={photo.url}
          alt="Your receipt"
          className="card max-h-[46dvh] w-auto max-w-full object-contain p-1"
        />
      )}
      <div className="mt-10 flex flex-col items-center">
        <Mascot size={64} label="Kit, the kit+ty kitten, is reading" />
        <p role="status" className="mt-3 text-headline font-semibold">
          <span key={phrase} className="animate-phrase inline-block">
            {phrase}
          </span>{' '}
          <span className="font-normal text-label-2">
            for <span className="tabular">{elapsed}</span> s
          </span>
          <span className="dots ml-0.5 text-label-2" aria-hidden>
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </p>
        <p className="mt-2 max-w-72 text-footnote text-label-2">
          Your agent is reading the receipt. Everything stays on your phone: the photo is never sent
          over the internet.
        </p>
        <AiNote className="mt-3" />
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
  const row = (key: string, label: ReactNode, field: ReactNode, last = false) => (
    <li
      key={key}
      className={`ml-4 flex min-h-11 items-center gap-3 pr-4 ${last ? '' : 'hairline-b'}`}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {field}
    </li>
  );
  const amount = (value: bigint, set: (v: bigint) => void) => (
    <AmountInput value={value} currency={r.currency} disabled={disabled} onChange={set} />
  );
  return (
    <div className="space-y-1.5">
      <input
        value={r.merchant}
        disabled={disabled}
        onChange={(e) => onChange({ ...r, merchant: e.target.value })}
        aria-label="Merchant"
        className="min-h-11 w-full bg-transparent px-4 text-headline font-semibold"
      />
      <Section footer={`${r.date} · ${r.currency}`}>
        <ul>
          {r.items.map((it, i) =>
            row(
              `item${i}`,
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
                className="min-h-11 w-full bg-transparent text-body"
              />,
              amount(it.total, (v) => onChange(withItemTotal(r, i, v))),
            ),
          )}
          {r.tax !== undefined &&
            row(
              'tax',
              'Tax',
              amount(r.tax, (v) => onChange({ ...r, tax: v })),
            )}
          {r.tip !== undefined &&
            row(
              'tip',
              'Tip',
              amount(r.tip, (v) => onChange({ ...r, tip: v })),
            )}
          {row(
            'total',
            <span className="font-semibold">Total</span>,
            <span className="flex items-center gap-1 font-semibold">
              {amount(r.total, (v) => v > 0n && onChange({ ...r, total: v }))}
              <span className="text-subhead text-label-2">{r.currency}</span>
            </span>,
            true,
          )}
        </ul>
      </Section>
      {gap !== 0n && (
        <p
          role="alert"
          className="rounded-control bg-danger-soft px-3 py-2 text-subhead text-label"
        >
          The rows {gap > 0n ? 'exceed' : 'are short of'} the total by{' '}
          {formatMinor(gap > 0n ? gap : -gap, r.currency)} {r.currency}. Fix a row or the total.
        </p>
      )}
      {r.warnings.map((w) => (
        <p key={w} className="px-4 text-footnote text-label-2">
          {w}
        </p>
      ))}
    </div>
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
      aria-label="Amount"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = text === null ? null : parseMinor(text, currency);
        if (v !== null) onChange(v);
        setText(null);
      }}
      className={`tabular h-8 w-24 rounded-[8px] bg-bg-fill px-2 text-right text-body ${invalid ? 'text-danger' : 'text-label'}`}
    />
  );
}
