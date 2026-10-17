import { formatCents } from '@kitty/shared';
import { Eye, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from './Avatar.js';
import { Amount } from './Text.js';
import { Button } from './Button.js';

// Money pieces of Home (DESIGN.md §7, wireframe): the balance pill, a history row, the card of a
// part waiting for me.

/** "50.00 DUSD" pill with the eye, and "Only you can spend it" under it (top left of Home). */
export function BalancePill({
  cents,
  hidden,
  onToggle,
}: {
  cents: bigint | null;
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="hairline tabular flex h-9 items-center rounded-full bg-bg-cell px-3.5 text-headline font-semibold">
          {cents === null ? '—' : hidden ? '••••' : formatCents(cents)}
          <span className="ml-1 text-footnote font-normal text-label-2">DUSD</span>
        </span>
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
      <p className="mt-0.5 pl-1 text-footnote text-label-2">
        {cents === null ? 'Your node is not answering' : 'Only you can spend it'}
      </p>
    </div>
  );
}

/** One line of a group's history: avatar on a timeline, title, description, amount and date. */
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
}) {
  return (
    <li className={`relative flex gap-3 py-2.5 ${muted ? 'text-label-3 line-through' : ''}`}>
      {connector && (
        <span aria-hidden className="absolute top-[52px] bottom-[-10px] left-5 w-px bg-separator" />
      )}
      <Avatar name={name} me={me} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-headline font-semibold">{title}</p>
        <p className={`line-clamp-2 text-subhead ${muted ? '' : 'text-label-2'}`}>{subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Amount cents={cents} sign={sign} />
        <span className="text-footnote text-label-2">{date}</span>
      </div>
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
        <p className="min-w-0 flex-1 text-headline font-semibold">{title}</p>
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
              {busy ? 'Signing…' : 'Approve'}
            </Button>
          )}
        </div>
      )}
      {children}
    </article>
  );
}
