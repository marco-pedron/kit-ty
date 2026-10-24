import { formatCents, type ApiClientError } from '@kitty/shared';
import { CircleHelp, LifeBuoy, LogOut, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { cap } from '../history.js';
import { toClientError } from '../state.js';
import { Avatar } from '../ui/Avatar.js';
import { NavBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Row, Section, Tile } from '../ui/List.js';
import { ErrorNote } from '../ui/Notes.js';
import { AlertDialog } from '../ui/Overlays.js';
import { Working } from '../ui/PlusMinus.js';
import type { ScreenProps } from './types.js';

// Profile (wireframe, top): photo, name, Funds with the real balance of my trip channel, FAQ and
// Assistance not available yet; limits live in each group.

export function ProfileScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  const name = cap(s?.members.find((m) => m.memberId === as)?.displayName ?? as);
  const balance = s?.me?.balance ?? null;
  const icon = { size: 18, strokeWidth: 1.75 };
  return (
    <>
      <NavBar title="Profile" large back={{ label: 'Home', onClick: () => go('home') }} />
      <div className="space-y-6 px-4">
        <div className="flex flex-col items-center pt-2">
          <Avatar name={name} me size={96} />
          <p className="mt-2 text-title2 font-bold">{name}</p>
        </div>
        <Section>
          <Row
            leading={
              <Tile tone="accent">
                <Wallet {...icon} />
              </Tile>
            }
            title="Funds"
            value={
              <span className="tabular">
                {balance === null
                  ? 'not available'
                  : `${formatCents(balance.tripOutboundCents)} DUSD`}
              </span>
            }
            chevron
            onClick={() => go('home')}
          />
          <Row
            leading={
              <Tile>
                <ShieldCheck {...icon} />
              </Tile>
            }
            title="Verified log"
            subtitle="Every event, checked on this phone"
            chevron
            onClick={() => go('log')}
          />
          <Row
            leading={
              <Tile>
                <CircleHelp {...icon} />
              </Tile>
            }
            title="FAQ"
            value="soon"
            disabled
          />
          <Row
            leading={
              <Tile>
                <LifeBuoy {...icon} />
              </Tile>
            }
            title="Assistance"
            value="soon"
            disabled
            last
          />
        </Section>
        <div className="text-center">
          <p className="text-footnote text-label-2">Limits are set per group.</p>
          <Button variant="plain" onClick={() => go('groups')}>
            Open Groups
          </Button>
        </div>
        {s?.registry === 'v2' && s.trip !== null && <LeaveTrip {...{ trip, as, go }} />}
      </div>
    </>
  );
}

/**
 * KITTY_REGISTRY=v2 (23/10): leaving the trip closes my two channels with the LSP from my own
 * wallet. Only without debts (disputed parts count); the trip closes when everyone has left.
 */
function LeaveTrip({ trip, go }: ScreenProps) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const owe = trip.state?.me?.oweCents ?? 0n;
  const leave = () => {
    setAsking(false);
    setBusy(true);
    setError(null);
    trip.client
      .leaveTrip()
      .then((r) => {
        setWarning(r.warning);
        trip.refresh();
        if (r.warning === null) go('home');
      })
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Section footer="Your channels with the LSP close and your funds come back on-chain. Nobody else can close them.">
      <Row
        leading={
          <Tile tone="accent">
            <LogOut size={18} strokeWidth={1.75} />
          </Tile>
        }
        title={busy ? 'Leaving: closing your channels…' : 'Leave the trip'}
        {...(owe > 0n && { subtitle: `You still owe ${formatCents(owe)} DUSD` })}
        value={busy ? <Working /> : undefined}
        disabled={busy || owe > 0n}
        onClick={() => setAsking(true)}
        last
      />
      {error && <ErrorNote error={error} className="mt-3" />}
      {warning !== null && <p className="mt-3 text-footnote text-label-2">{warning}</p>}
      {asking && (
        <AlertDialog
          title={`Leave ${trip.state?.trip?.name ?? 'the trip'}?`}
          message={
            <>
              Your two channels with the LSP will be closed and you cannot be added to new expenses.
              It takes about a minute.
              {trip.state?.me?.leaveWarning != null && (
                <span className="mt-2 block font-semibold">{trip.state.me.leaveWarning}</span>
              )}
            </>
          }
          confirm="Leave"
          destructive
          onCancel={() => setAsking(false)}
          onConfirm={leave}
        />
      )}
    </Section>
  );
}
