import { ScreenHeader } from '../components.js';
import type { ScreenProps } from './types.js';

// New expense: photo of the receipt → AI rows → parts → send (wired in C4c).

export function NewExpenseScreen({ go }: ScreenProps) {
  return (
    <>
      <ScreenHeader title="New expense" back="home" go={go} />
      <div className="flex min-h-[60dvh] flex-col items-center justify-end gap-3 px-6">
        <p className="text-center text-sm text-gray-500">
          Take a photo of the receipt. It never leaves this phone.
        </p>
        <div className="flex overflow-hidden rounded-full border border-gray-300 bg-white shadow-sm">
          <button type="button" aria-label="Photo of the receipt" className="px-8 py-3 text-2xl">
            📷
          </button>
          <span className="w-px bg-gray-300" />
          <button
            type="button"
            disabled
            aria-label="Voice, coming soon"
            className="flex items-center gap-1 px-8 py-3 text-2xl opacity-40"
          >
            🎤<span className="text-xs font-medium">soon</span>
          </button>
        </div>
      </div>
    </>
  );
}
