import { formatCents } from '@kitty/shared';
import { CircleHelp, LifeBuoy, ShieldCheck, UserCog } from 'lucide-react';
import { guaranteeLeft } from '../../dave.js';
import { cap } from '../../history.js';
import { memberStanding } from '../../slider.js';
import { Avatar } from '../../ui/Avatar.js';
import { Badge } from '../../ui/Badge.js';
import { NavBar } from '../../ui/Bars.js';
import { Row, Section, Tile } from '../../ui/List.js';
import { StateView } from '../../ui/Overlays.js';
import type { DaveProps } from './DaveApp.js';

// Members, Log and Profile of the operator (wireframe-dave.pdf). Privacy (SPEC §1): Dave sees
// each member's standing and guarantee, never their channel balance.

export function MembersScreen({ state: s, go }: DaveProps) {
  const ops = new Map((s.coordinator?.members ?? []).map((m) => [m.memberId, m]));
  return (
    <>
      <NavBar title="Members" large back={{ label: 'Home', onClick: () => go({ name: 'home' }) }} />
      <div className="px-4">
        {s.members.length === 0 ? (
          <StateView
            kind="empty"
            title="No members yet"
            text="Travelers appear once they join the trip."
          />
        ) : (
          <Section footer="Channel balances stay private: the operator sees the guarantee, not the funds.">
            {s.members.map((m) => {
              const st = memberStanding(m, s.expenses);
              const op = ops.get(m.memberId);
              return (
                <Row
                  key={m.memberId}
                  leading={<Avatar name={m.displayName} />}
                  title={cap(m.displayName)}
                  subtitle={
                    st === 'excluded'
                      ? `channels closed · credit ${formatCents(op?.operatorCreditCents ?? 0n)}`
                      : `guarantee left ${formatCents(op?.guaranteeLeftCents ?? 0n)}`
                  }
                  value={<Badge kind={st}>{st}</Badge>}
                />
              );
            })}
            <Row
              leading={<Avatar name="dave" me />}
              title="Dave"
              subtitle={`guarantee left ${formatCents(guaranteeLeft(s))} in all`}
              value={<Badge kind="operator">operator</Badge>}
              last
            />
          </Section>
        )}
      </div>
    </>
  );
}

/** Task C6 replaces this with the relay's events verified in the browser. */
export function DaveLog({ state: s, go }: DaveProps) {
  const h = s.ledger;
  return (
    <>
      <NavBar title="Log" large back={{ label: 'Home', onClick: () => go({ name: 'home' }) }} />
      <div className="space-y-6 px-4">
        <Section>
          <Row
            leading={
              <Tile tone="accent">
                <ShieldCheck size={18} strokeWidth={1.75} />
              </Tile>
            }
            title={h.chainValid ? 'Chain verified' : 'Chain broken'}
            subtitle={`${h.events} events · ${h.validSignatures}/${h.events} signatures valid`}
            last
          />
        </Section>
        {s.activity.length === 0 ? (
          <StateView kind="empty" title="Nothing signed yet" />
        ) : (
          <Section header="Activity">
            {s.activity.slice(0, 40).map((a, i, all) => (
              <Row
                key={`${a.at}-${i}`}
                title={a.text}
                subtitle={new Date(a.at).toLocaleTimeString('en-GB')}
                last={i === all.length - 1}
              />
            ))}
          </Section>
        )}
      </div>
    </>
  );
}

export function DaveProfile({ state: s, go }: DaveProps) {
  const icon = { size: 18, strokeWidth: 1.75 };
  return (
    <>
      <NavBar title="Profile" large back={{ label: 'Home', onClick: () => go({ name: 'home' }) }} />
      <div className="space-y-6 px-4">
        <div className="flex flex-col items-center pt-2">
          <Avatar name="Dave" me size={80} />
          <p className="mt-3 text-title2 font-bold">Dave</p>
        </div>
        <Section>
          <Row
            leading={
              <Tile>
                <UserCog {...icon} />
              </Tile>
            }
            title="Role"
            value="operator"
          />
          <Row
            leading={
              <Tile tone="accent">
                <ShieldCheck {...icon} />
              </Tile>
            }
            title="Guarantee funds"
            value={<span className="tabular">{formatCents(guaranteeLeft(s))} DUSD</span>}
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
      </div>
    </>
  );
}
