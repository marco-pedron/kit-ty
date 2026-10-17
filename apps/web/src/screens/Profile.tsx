import { formatCents } from '@kitty/shared';
import { CircleHelp, LifeBuoy, ShieldCheck, Wallet } from 'lucide-react';
import { cap } from '../history.js';
import { Avatar } from '../ui/Avatar.js';
import { NavBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Row, Section, Tile } from '../ui/List.js';
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
          <Avatar name={name} me size={80} />
          <p className="mt-3 text-title2 font-bold">{name}</p>
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
      </div>
    </>
  );
}
