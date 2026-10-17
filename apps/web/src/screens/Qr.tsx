import { QrCode, ScanLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import { encode } from 'uqr';
import { NavBar } from '../ui/Bars.js';
import { Segmented } from '../ui/Controls.js';
import { StateView } from '../ui/Overlays.js';
import type { ScreenProps } from './types.js';

// "Your kit+ty ID" (wireframe, right of Home): the member's public key, the author key of every
// event they sign, as a QR, with a Scan / Show switch at the bottom. Opens on Show; Scan shows the
// frame only: joining a group by QR is not built yet and the camera is never used.

/** "7f3a 91c0 … 5be2 c21e": the first and last 8 hex characters in groups of four. */
export function shortKey(hex: string): string {
  const g = (s: string) => s.match(/.{1,4}/g)?.join(' ') ?? s;
  return hex.length <= 16 ? g(hex) : `${g(hex.slice(0, 8))} … ${g(hex.slice(-8))}`;
}

export function QrScreen({ trip, as, go }: ScreenProps) {
  const [mode, setMode] = useState<'scan' | 'show'>('show');
  const pubkey = trip.state?.members.find((m) => m.memberId === as)?.pubkey ?? null;

  return (
    <>
      <NavBar title="Your kit+ty ID" back={{ label: 'Home', onClick: () => go('home') }} />
      <div className="flex min-h-[calc(100dvh-44px-var(--tab-bar-space))] flex-col items-center px-4 pt-8">
        {mode === 'show' ? (
          pubkey === null ? (
            <StateView
              kind="loading"
              title="Your ID is on its way"
              text="It appears once you have joined the trip."
            />
          ) : (
            <>
              <div className="rounded-card bg-qr-paper p-5">
                <QrImage text={pubkey} />
              </div>
              <p className="mt-5 font-mono text-subhead text-label-2" aria-label={`Key ${pubkey}`}>
                {shortKey(pubkey)}
              </p>
              <p className="mt-1 text-footnote text-label-2">Show it to join a group.</p>
            </>
          )
        ) : (
          <ScanFrame />
        )}
        <div className="mt-auto w-full max-w-60 pt-8 pb-10">
          <Segmented
            label="QR mode"
            value={mode}
            onChange={setMode}
            options={[
              {
                key: 'scan',
                label: (
                  <>
                    <ScanLine size={16} strokeWidth={1.75} /> Scan
                  </>
                ),
              },
              {
                key: 'show',
                label: (
                  <>
                    <QrCode size={16} strokeWidth={1.75} /> Show
                  </>
                ),
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}

function ScanFrame() {
  const corner = 'absolute size-12 border-label';
  return (
    <div className="flex flex-col items-center">
      <div className="relative size-64">
        <span className={`${corner} top-0 left-0 rounded-tl-card border-t-2 border-l-2`} />
        <span className={`${corner} top-0 right-0 rounded-tr-card border-t-2 border-r-2`} />
        <span className={`${corner} bottom-0 left-0 rounded-bl-card border-b-2 border-l-2`} />
        <span className={`${corner} right-0 bottom-0 rounded-br-card border-r-2 border-b-2`} />
        <span className="absolute inset-x-6 top-8 h-0.5 rounded-full bg-accent" />
        <p className="absolute inset-0 grid place-items-center text-headline font-semibold">
          Scan QR Code
        </p>
      </div>
      <p className="mt-5 text-subhead text-label-2">Join group: coming soon</p>
    </div>
  );
}

function QrImage({ text }: { text: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 1 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { d, size: data.length };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${path.size} ${path.size}`}
      role="img"
      aria-label="QR code of your kit+ty ID"
      className="size-56"
      shapeRendering="crispEdges"
    >
      <path d={path.d} className="fill-qr-ink" />
    </svg>
  );
}
