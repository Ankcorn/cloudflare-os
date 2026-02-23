import { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

// Extract a base URL from a resource pattern, e.g. "https://jira.cfdata.org/*" → "https://jira.cfdata.org/"
// Returns null for wildcard hostnames (e.g. "https://*.example.com/*") since we can't pre-fill.
export function extractBaseUrl(pattern: string): string | null {
  const match = pattern.match(/^(https?:\/\/[^/*:]+(?:\/[^*]*)?)/)
  if (!match) return null
  return match[1].endsWith('/') ? match[1] : match[1] + '/'
}

// Extract the hostname from a pattern, including wildcard subdomains.
// e.g. "https://jira.cfdata.org/*" → "jira.cfdata.org"
// e.g. "https://*.prometheus-access.cfdata.org/*" → "*.prometheus-access.cfdata.org"
export function extractHostname(pattern: string): string | null {
  const match = pattern.match(/^https?:\/\/([^/:]+)/)
  if (!match) return null
  const hostname = match[1].replace(/\*+$/, '') // strip trailing wildcard (e.g. https://*)
  return hostname || null
}

// URL prefix match: strip scheme and trailing wildcards, then check if one is a prefix
// of the other. Handles partial typing ("jira.cfdata.or") and full URLs with paths.
// Also handles wildcard subdomain patterns like "*.prometheus-access.cfdata.org".
export function matchesResourceUrl(search: string, pattern: string): boolean {
  const stripScheme = (s: string) => s.replace(/^https?:\/\//, '').toLowerCase()
  const s = stripScheme(search).replace(/\*+$/, '')
  const p = stripScheme(pattern).replace(/\*+$/, '')
  if (!s) return false

  // Wildcard subdomain: *.foo.com matches anything.foo.com
  if (p.startsWith('*.')) {
    const suffixHost = p.slice(1).split('/')[0] // ".foo.com"
    const searchHost = s.split('/')[0]
    if (searchHost.endsWith(suffixHost) || suffixHost.startsWith('.' + searchHost)) return true
  }

  return p.startsWith(s) || s.startsWith(p)
}

// Check if search text matches a resource. Tries URL prefix matching (scheme-optional),
// then falls back to multi-word token matching against title/description/pattern.
export function matchesResource(search: string, resource: SupportedResource): boolean {
  if (matchesResourceUrl(search.trim(), resource.urlPattern)) return true
  const corpus = `${resource.title} ${resource.description} ${resource.urlPattern}`.toLowerCase()
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every(t => corpus.includes(t))
}
