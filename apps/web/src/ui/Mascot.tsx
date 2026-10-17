import svgSource from '../../../../docs/design/kitty-mascot.svg?raw';

// The +ty kitten (DESIGN.md §7): docs/design/kitty-mascot.svg inlined, not an <img>, so its
// colour variables (--kitty-cat-line, --kitty-cat-fill) and the #paw animation work. Its generic
// class names are renamed so its <style> never reaches the rest of the page.

const svg = svgSource
  .replace(/\.fill\b/g, '.kc-fill')
  .replace(/\.line\b/g, '.kc-line')
  .replace(/class="fill"/g, 'class="kc-fill"')
  .replace(/class="line"/g, 'class="kc-line"')
  .replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true" width="100%" height="100%"');

const SIZES = { 22: 'size-[22px]', 40: 'size-10', 64: 'size-16', 96: 'size-24', 128: 'size-32' };

export function Mascot({
  size = 96,
  waving = true,
  label,
}: {
  size?: keyof typeof SIZES;
  waving?: boolean;
  label?: string;
}) {
  return (
    <span
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={`inline-block shrink-0 ${SIZES[size]} ${waving ? '' : 'mascot-still'}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
