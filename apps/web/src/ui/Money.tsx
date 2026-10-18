import { formatCents } from '@kitty/shared';
import { Banknote, Eye, EyeOff, Plus, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from './Avatar.js';
import { Amount } from './Text.js';
import { Button } from './Button.js';
import { Mascot } from './Mascot.js';
import { Elapsed } from './Notes.js';
import { Working } from './PlusMinus.js';

// Money pieces of Home (DESIGN.md §7, wireframe): the balance pill, a history row, the card of a
// part waiting for me.

/** "50.00 DUSD" pill with the eye, and "Only you can spend it" under it (top left of Home). */
export function BalancePill({
  cents,
  hidden,
  onToggle,
  onOpen,
  caption = 'Only you can spend it',
  aside,
}: {
  cents: bigint | null;
  hidden: boolean;
  onToggle: () => void;
  /** A tap on the amount: the traveler's channel opens the limit slider. */
  onOpen?: { label: string; onClick: () => void };
  /** Under the pill: whose money this is. */
  caption?: string;
  /** Next to the caption (the "Top up · soon" pill). */
  aside?: ReactNode;
}) {
  const amount = (
    <>
      {cents === null ? '—' : hidden ? '••••' : formatCents(cents)}
      <span className="ml-1 text-footnote font-normal text-label-2">DUSD</span>
    </>
  );
  const pill =
    'hairline tabular flex h-9 items-center rounded-full bg-bg-cell px-3.5 text-headline font-semibold';
  return (
    <div>
      <div className="flex items-center gap-1">
        {onOpen === undefined ? (
          <span className={pill}>{amount}</span>
        ) : (
          <button
            type="button"
            onClick={onOpen.onClick}
            aria-label={onOpen.label}
            className={`pressable ${pill} active:bg-bg-fill`}
          >
            {amount}
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={hidden ? 'Show balance' : 'Hide balance'}
          aria-pressed={hidden}
          className="pressable grid size-11 place-items-center text-label-2"
        >
          {hidden ? <EyeOff size={22} strokeWidth={1.75} /> : <Eye size={22} strokeWidth={1.75} />}
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-1">
        <p className="text-footnote whitespace-nowrap text-label-2">
          {cents === null ? 'Your node is not answering' : caption}
        </p>
        {aside}
      </div>
    </div>
  );
}

/** "Top up" is not built yet (SPEC §6.9: a second trip channel): shown, disabled, with "soon". */
export function TopUpSoon() {
  return (
    <button
      type="button"
      disabled
      aria-label="Top up, coming soon"
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-bg-fill pr-1 pl-2.5 text-caption font-semibold whitespace-nowrap text-label-3"
    >
      <Plus size={12} strokeWidth={2.5} />
      Top up
      <span className="rounded-full bg-bg-cell px-1.5 text-label-2">soon</span>
    </button>
  );
}

/** "17 Oct": the day a fiat receipt's rate was locked. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * One line of a group's history: avatar on a timeline, title, description, amount and date.
 * A receipt paid in fiat sits on a tinted background with its currency and the rate's date; a
 * Lightning payment in DUSD has a plain background and a small "Lightning" tag.
 */
export function TransactionRow({
  name,
  me = false,
  title,
  subtitle,
  cents,
  sign,
  date,
  connector = false,
  muted = false,
  onClick,
  waitingSince = null,
  fiat = null,
}: {
  name: string;
  me?: boolean;
  title: string;
  subtitle: string;
  cents: bigint;
  sign: '+' | '-' | null;
  date: string;
  /** Draws the timeline down to the next row. */
  connector?: boolean;
  muted?: boolean;
  /** Opens the proof of this payment. */
  onClick?: () => void;
  /** Waiting for others: the kitten in place of the avatar and the time elapsed. */
  waitingSince?: string | null;
  fiat?: { amount: string; currency: string; rateLockedAt: string } | null;
}) {
  const content = (
    <>
      {connector && (
        <span aria-hidden className="absolute top-[52px] bottom-[-10px] left-5 w-px bg-separator" />
      )}
      {waitingSince === null ? <Avatar name={name} me={me} /> : <Mascot size={40} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-headline font-semibold">{title}</p>
        <p className={`line-clamp-2 text-subhead ${muted ? '' : 'text-label-2'}`}>
          {subtitle}
          {waitingSince !== null && (
            <>
              {' '}
              <Elapsed since={waitingSince} />
            </>
          )}
        </p>
        <span
          className={`mt-1 inline-flex h-5 items-center gap-1 rounded-full px-2 text-caption font-semibold ${fiat === null ? 'bg-accent-soft text-label' : 'bg-bg-cell text-label-2'}`}
        >
          {fiat === null ? (
            <>
              <Zap size={11} strokeWidth={2.5} aria-hidden />
              Lightning · DUSD
            </>
          ) : (
            <>
              <Banknote size={12} strokeWidth={2} aria-hidden />
              {fiat.currency} · cash or card
            </>
          )}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        {fiat === null ? (
          <Amount cents={cents} sign={sign} unit />
        ) : (
          <>
            <span className="tabular text-headline font-semibold text-label">
              {sign === '-' ? '−' : ''}
              {fiat.amount}
              <span className="ml-1 text-footnote font-normal text-label-2">{fiat.currency}</span>
            </span>
            <span className="tabular text-footnote text-label-2">≈ {formatCents(cents)} DUSD</span>
            <span className="text-caption text-label-2">rate of {day(fiat.rateLockedAt)}</span>
          </>
        )}
        <span className="text-footnote text-label-2">{date}</span>
      </div>
    </>
  );
  const tint = fiat === null ? '' : 'bg-fiat-tint';
  return (
    <li className="relative">
      {onClick === undefined ? (
        <div
          className={`-mx-2 flex gap-3 rounded-control px-2 py-2.5 ${tint} ${muted ? 'text-label-3 line-through' : ''}`}
        >
          {content}
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-label={`${title}: see the proof`}
          className={`pressable -mx-2 flex w-[calc(100%+16px)] gap-3 rounded-control px-2 py-2.5 text-left active:bg-bg-fill ${tint}`}
        >
          {content}
        </button>
      )}
    </li>
  );
}

/** A part waiting for me (§7): accent-soft block, agent sentence, countdown, Dispute / Approve. */
export function ApprovalCard({
  title,
  sentence,
  countdown,
  onDispute,
  onApprove,
  busy,
  note,
  children,
}: {
  title: string;
  sentence: string;
  countdown: string | null;
  onDispute?: () => void;
  onApprove?: () => void;
  busy: boolean;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <article className="rounded-card bg-accent-soft p-4" data-noswipe>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 truncate text-headline font-semibold">{title}</p>
        {countdown !== null && (
          <span
            className="tabular text-headline font-semibold text-accent-text"
            aria-label={`${countdown} left`}
          >
            {countdown}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-subhead text-label-2">{sentence}</p>
      {note !== undefined && <p className="mt-1 text-subhead text-label">{note}</p>}
      {(onDispute !== undefined || onApprove !== undefined) && (
        <div className="mt-3 flex gap-2">
          {onDispute !== undefined && (
            <Button variant="gray" full onClick={onDispute} disabled={busy}>
              Dispute
            </Button>
          )}
          {onApprove !== undefined && (
            <Button full onClick={onApprove} disabled={busy}>
              {busy ? <Working /> : 'Approve'}
            </Button>
          )}
        </div>
      )}
      {children}
    </article>
  );
}
