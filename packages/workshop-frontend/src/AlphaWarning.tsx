/**
 * Small inline warning banner that appears centered in the top bar.
 *
 * Designed to be placed inside a flex container that has `position: relative`;
 * it absolutely-centers itself so it doesn't affect the left/right layout.
 * Hidden below the `lg` breakpoint where it would crowd the bar.
 */
export default function AlphaWarning() {
  return (
    <div
      aria-hidden="false"
      className="hidden lg:flex absolute inset-0 items-center justify-center pointer-events-none"
    >
      <span className="text-xs font-medium text-kumo-warning whitespace-nowrap">
        Warning: Gadgets is still in alpha. All data may be deleted.
      </span>
    </div>
  )
}
