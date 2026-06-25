// Runtime accent (brand) theming.
//
// The base theme is defined statically in styles.css via Tailwind `@theme` CSS variables. We let a
// deployment override the *accent* family at runtime by setting those CSS variables on :root from an
// admin-chosen seed color. Hover/lighter/selection shades are derived from the seed with CSS
// relative-color syntax (`oklch(from <seed> ...)`), so the admin only picks one color.
//
// Only the accent-related variables are overridden; backgrounds, lines, and neutral text keep the
// base (warm) theme. The seed is always a validated hex string (see isHexColor), so interpolating it
// into the CSS strings below is safe.

import { isHexColor } from '@gadgets/workshop-shared/api'

// Variables set directly to the seed color.
const SEED_VARS = [
  '--color-kumo-brand',
  '--color-accent-100',
  '--text-color-kumo-brand',
  '--text-color-kumo-link',
]

// Variables derived from the seed, as (name -> value-template) pairs.
function derivedVars(seed: string): Record<string, string> {
  return {
    // Slightly darker for hover/pressed states.
    '--color-kumo-brand-hover': `oklch(from ${seed} calc(l - 0.06) c h)`,
    // Lighter/brighter secondary accent.
    '--color-accent-200': `oklch(from ${seed} calc(l + 0.08) c h)`,
    // Soft tinted selection background + readable selection text.
    '--color-selection-bg': `oklch(from ${seed} 0.94 calc(c * 0.35) h)`,
    '--color-selection-text': `oklch(from ${seed} calc(l - 0.06) c h)`,
  }
}

const ALL_VARS = [...SEED_VARS, ...Object.keys(derivedVars('#000'))]

// Apply the accent color to the document root. Pass "" / invalid to clear back to the base theme.
export function applyAccentColor(color: string | null | undefined): void {
  const root = document.documentElement
  if (!color || !isHexColor(color)) {
    for (const v of ALL_VARS) root.style.removeProperty(v)
    return
  }
  for (const v of SEED_VARS) root.style.setProperty(v, color)
  for (const [v, value] of Object.entries(derivedVars(color))) {
    root.style.setProperty(v, value)
  }
}

// The base/default accent, shown in the admin picker when no custom color is set.
export const DEFAULT_ACCENT_COLOR = '#ff4801'
