import type { ApiClientError } from '@kitty/shared';
import { Button } from './Button.js';

// Inline errors (DESIGN.md §2, §7): a human sentence and what to do; red only for errors.

export function ErrorNote({
  error,
  onRetry,
  className = '',
}: {
  error: ApiClientError;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={`rounded-control bg-danger-soft px-3 py-2.5 ${className}`}>
      <p className="text-subhead text-label">{error.message}</p>
      <p className="text-subhead font-semibold text-label">{error.action}</p>
      {onRetry !== undefined && (
        <Button variant="plain" onClick={onRetry} className="-ml-4">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Banner({ children }: { children: string }) {
  return (
    <p className="truncate bg-accent-soft px-4 py-1 text-center text-caption font-semibold text-label">
      {children}
    </p>
  );
}
