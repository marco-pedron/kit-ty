import type { ReactNode } from 'react';

// Segmented control and the iOS limit slider (DESIGN.md §7).

export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { key: K; label: ReactNode }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex rounded-control bg-bg-fill p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={`pressable flex min-h-9 min-w-24 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-3 text-subhead font-semibold ${value === o.key ? 'hairline bg-bg-cell text-label' : 'text-label-2'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Track --bg-fill, filled part --positive, white round 28px thumb (the native range on top). */
export function Slider({
  value,
  max,
  onChange,
  onCommit,
  disabled = false,
  label,
  valueText,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  onCommit: () => void;
  disabled?: boolean;
  label: string;
  valueText: string;
}) {
  const filled = max === 0 ? 0 : (value / max) * 100;
  return (
    <div className="relative h-11" data-noswipe>
      <div className="absolute inset-x-3.5 top-1/2 h-1 -translate-y-1/2 rounded-full bg-bg-fill" />
      <div
        className="absolute top-1/2 left-3.5 h-1 -translate-y-1/2 rounded-full bg-positive"
        style={{ width: `calc((100% - 28px) * ${filled / 100})` }}
      />
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        aria-label={label}
        aria-valuetext={valueText}
        className="range-ios relative"
      />
    </div>
  );
}
