import {
  ApiClientError,
  formatCents,
  type Receipt,
  type SplitAssignment,
  type SplitPreview,
} from '@kitty/shared';
import { Camera, Mic, ScanLine } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { cap } from '../history.js';
import { formatMinor, parseMinor, receiptGap, withItemTotal } from '../receipt-edit.js';
import { toClientError, useNow } from '../state.js';
import { Badge } from '../ui/Badge.js';
import { NavBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Section } from '../ui/List.js';
import { Mascot } from '../ui/Mascot.js';
import { ErrorNote } from '../ui/Notes.js';
import type { ScreenProps } from './types.js';

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
    setStartedAt(Date.now());
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
        <div className="flex flex-col items-center px-8 pt-6 text-center">
          {photo && (
            <img
              src={photo.url}
              alt="Your receipt"
              className="h-40 w-32 rounded-card bg-bg-cell object-cover"
            />
          )}
          <div className="mt-8">
            <Mascot size={128} label="The kit+ty kitten is reading" />
          </div>
          <p className="mt-4 text-headline font-semibold">Reading the receipt</p>
          <p className="text-subhead text-label-2" role="status">
            on your phone… <Elapsed since={startedAt} />
          </p>
        </div>
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
          <ReceiptEditor receipt={receipt} onChange={edit} disabled={splitting || sending} />

          <Section header="Split between">
            <div className="space-y-3 p-4">
              <label htmlFor="who" className="sr-only">
                Who had what?
              </label>
              <textarea
                id="who"
                rows={2}
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                placeholder="Who had what? For example: taxi for all three"
                className="w-full resize-none rounded-control bg-bg-fill px-3 py-2.5 text-body placeholder:text-label-3"
              />
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
                {splitting ? 'Splitting on your phone…' : 'Split with AI'}
              </Button>
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
                    <span className="tabular font-semibold">{formatCents(sh.cents)}</span>
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
            {sending ? 'Signing and sending…' : 'Send to the group'}
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

function Elapsed({ since }: { since: number }) {
  const now = useNow(100);
  const tenths = Math.max(0, Math.floor((now - since) / 100));
  return (
    <span className="tabular">
      {Math.floor(tenths / 10)}.{tenths % 10} s
    </span>
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
