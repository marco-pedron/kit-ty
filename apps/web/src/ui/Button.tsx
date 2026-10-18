import type { ButtonHTMLAttributes, ReactNode } from 'react';

// iOS buttons (DESIGN.md §3 roles): filled = primary (Approve, Send), gray = secondary (Dispute,
// Cancel), plain = light action (See all), destructive = tinted red (Cover and exclude).

export type ButtonVariant = 'filled' | 'gray' | 'plain' | 'destructive';

const VARIANT: Record<ButtonVariant, string> = {
  filled: 'bg-accent text-on-accent disabled:bg-bg-fill disabled:text-label-3',
  gray: 'bg-bg-fill text-label disabled:text-label-3',
  plain: 'bg-transparent text-accent-text active:bg-bg-fill disabled:text-label-3',
  destructive: 'bg-danger-soft text-danger disabled:text-label-3',
};

export function Button({
  variant = 'filled',
  full = false,
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: {
  variant?: ButtonVariant;
  full?: boolean;
  icon?: ReactNode;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-headline font-semibold ${VARIANT[variant]} ${full ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
