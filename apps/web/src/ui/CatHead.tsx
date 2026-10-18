import alice from '../assets/heads/kitty-head-alice.svg?raw';
import angry from '../assets/heads/kitty-head-angry.svg?raw';
import bob from '../assets/heads/kitty-head-bob.svg?raw';
import charlie from '../assets/heads/kitty-head-charlie.svg?raw';
import dave from '../assets/heads/kitty-head-dave.svg?raw';
import happy from '../assets/heads/kitty-head-happy.svg?raw';
import out from '../assets/heads/kitty-head-out.svg?raw';
import worried from '../assets/heads/kitty-head-worried.svg?raw';

// The kitten's heads (DESIGN.md §7): pixel art inlined, one per member and one per mood, so the
// colour variables work and every pixel stays sharp at any size (shape-rendering crispEdges).

const HEADS = { happy, angry, worried, out, alice, bob, charlie, dave };
export type HeadVariant = keyof typeof HEADS;

const svgOf = (v: HeadVariant) =>
  HEADS[v].replace(
    / role="img" aria-label="[^"]*"/,
    ' aria-hidden="true" width="100%" height="100%"',
  );

/** A member's own head; anyone unknown gets the happy one. */
export const headOf = (name: string): HeadVariant => {
  const n = name.toLowerCase();
  return n === 'alice' || n === 'bob' || n === 'charlie' || n === 'dave' ? n : 'happy';
};

export function CatHead({
  variant,
  size = 32,
  label,
  className = '',
}: {
  variant: HeadVariant;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={`inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgOf(variant) }}
    />
  );
}
