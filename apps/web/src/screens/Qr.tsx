import { useMemo } from 'react';
import { encode } from 'uqr';
import { EmptyState, ScreenHeader } from '../components.js';
import type { ScreenProps } from './types.js';

// "Your kit+ty ID": the member's public key (the author key of every event they sign) as a QR.

export function QrScreen({ trip, as, go }: ScreenProps) {
  const pubkey = trip.state?.members.find((m) => m.memberId === as)?.pubkey ?? null;
  return (
    <>
      <ScreenHeader title="Your kit+ty ID" back="home" go={go} />
      {pubkey === null ? (
        <EmptyState>Your ID appears here once you have joined the trip.</EmptyState>
      ) : (
        <div className="flex flex-col items-center gap-4 px-6 pt-6">
          <QrCode text={pubkey} />
          <p className="text-center text-sm text-gray-600">
            Show this code to join a group as <span className="font-medium">{as}</span>.
          </p>
          <p className="font-mono text-xs break-all text-gray-400">{pubkey}</p>
        </div>
      )}
    </>
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
      className="size-64 rounded-2xl bg-white shadow-sm"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="black" />
    </svg>
  );
}
