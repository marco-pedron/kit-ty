import { useMemo, useState } from 'react';
import { encode } from 'uqr';
import type { ScreenProps } from './types.js';

// Full-screen QR (fintech reference): a Scan / Show switch at the bottom. Show (the default) is
// "Your kit+ty ID", the member's public key, the author key of every event they sign. Scan shows
// the scanning frame only: joining a group by QR is not built yet, and the camera is never used.

export function QrScreen({ trip, as, go }: ScreenProps) {
  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const pubkey = trip.state?.members.find((m) => m.memberId === as)?.pubkey ?? null;

  return (
    <div className="fixed inset-0 z-10 mx-auto flex max-w-[420px] flex-col bg-gray-900 text-white">
      <div className="flex justify-start p-4">
        <button
          type="button"
          onClick={() => go('home')}
          aria-label="Back"
          className="rounded-full bg-white/15 px-4 py-2 text-sm font-medium"
        >
          ‹ Home
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-40">
        {mode === 'show' ? (
          pubkey === null ? (
            <p className="text-center text-sm text-white/70">
              Your ID appears here once you have joined the trip.
            </p>
          ) : (
            <>
              <QrCode text={pubkey} />
              <p className="text-lg font-semibold">Your kit+ty ID</p>
              <p className="max-w-64 text-center font-mono text-xs break-all text-white/50">
                {pubkey}
              </p>
            </>
          )
        ) : (
          <ScanFrame />
        )}
      </div>

      <div
        role="tablist"
        aria-label="QR mode"
        className="absolute inset-x-0 bottom-28 mx-auto flex w-fit rounded-full border border-white/30 bg-white/10 p-1"
      >
        {(['scan', 'show'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-full px-6 py-2 text-sm font-semibold ${mode === m ? 'bg-black text-white' : 'text-white/80'}`}
          >
            {m === 'scan' ? '⌗ Scan' : '▦ Show'}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScanFrame() {
  const corner = 'absolute size-14 border-white';
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative size-64">
        <span className={`${corner} top-0 left-0 rounded-tl-2xl border-t-4 border-l-4`} />
        <span className={`${corner} top-0 right-0 rounded-tr-2xl border-t-4 border-r-4`} />
        <span className={`${corner} bottom-0 left-0 rounded-bl-2xl border-b-4 border-l-4`} />
        <span className={`${corner} right-0 bottom-0 rounded-br-2xl border-r-4 border-b-4`} />
        <span className="absolute inset-x-4 top-6 h-0.5 bg-red-500" />
        <p className="absolute inset-0 grid place-items-center text-sm font-medium">Scan QR Code</p>
      </div>
      <p className="text-sm text-white/70">Join group: coming soon</p>
    </div>
  );
}

function QrCode({ text }: { text: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { d, size: data.length };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${path.size} ${path.size}`}
      role="img"
      aria-label="QR code of your kit+ty ID"
      className="size-64 rounded-2xl bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="black" />
    </svg>
  );
}
