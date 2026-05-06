import { logoComponents } from './ConnectionLogos'

const VENDOR_LOGO_MAP: Record<string, string> = {
  slack: 'slack',
  discord: 'discord',
  jira: 'jira',
  google: 'google',
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  figma: 'figma',
}

const VENDOR_COLORS: Record<string, string> = {
  slack: '#f4ecf5',
  discord: '#eef0ff',
  jira: '#e6efff',
  google: '#e8f0fe',
  github: '#f0f0f0',
  notion: '#f5f5f5',
  linear: '#eeeffa',
  figma: '#fef0ec',
}

// Hostname-suffix → vendor id. Suffix-match (not substring) so e.g.
// "mygithub.org" doesn't resolve to GitHub.
const HOSTNAME_VENDOR_MAP: Array<[string, string]> = [
  ['github.com', 'github'],
  ['google.com', 'google'],
  ['slack.com', 'slack'],
  ['atlassian.net', 'jira'],
  ['atlassian.com', 'jira'],
  ['notion.so', 'notion'],
  ['linear.app', 'linear'],
  ['figma.com', 'figma'],
]

function vendorFromUrl(resourceUrl: string | undefined): string | undefined {
  if (!resourceUrl) return undefined
  let host: string
  try {
    host = new URL(resourceUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  for (const [suffix, vendor] of HOSTNAME_VENDOR_MAP) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return vendor
  }
  return undefined
}

// Binding-name token → vendor id. Match by token (split on non-alphanumerics)
// rather than substring, so "myDocsHelper" doesn't claim to be Google Docs.
const BINDING_TOKEN_VENDOR_MAP: Record<string, string> = {
  github: 'github',
  google: 'google',
  docs: 'google',
  drive: 'google',
  sheets: 'google',
  slack: 'slack',
  jira: 'jira',
  notion: 'notion',
  linear: 'linear',
  figma: 'figma',
}

function vendorFromBindingName(bindingName: string | undefined): string | undefined {
  if (!bindingName) return undefined
  const tokens = bindingName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const token of tokens) {
    const vendor = BINDING_TOKEN_VENDOR_MAP[token]
    if (vendor) return vendor
  }
  return undefined
}

function inferVendorId({
  vendorId,
  resourceUrl,
  bindingName,
}: {
  vendorId?: string
  resourceUrl?: string
  bindingName?: string
}) {
  if (vendorId) return vendorId.toLowerCase()
  return vendorFromUrl(resourceUrl) ?? vendorFromBindingName(bindingName)
}

export function GatekeeperIcon({
  vendorId,
  resourceUrl,
  bindingName,
  size = 16,
  className = 'h-8 w-8 rounded-lg',
}: {
  vendorId?: string
  resourceUrl?: string
  bindingName?: string
  size?: number
  className?: string
}) {
  const inferredVendorId = inferVendorId({ vendorId, resourceUrl, bindingName })
  const logoKey = inferredVendorId ? VENDOR_LOGO_MAP[inferredVendorId] ?? inferredVendorId : undefined
  const Logo = logoKey ? logoComponents[logoKey] : undefined

  return (
    <div
      className={`flex shrink-0 items-center justify-center ${className}`}
      style={{ backgroundColor: inferredVendorId ? VENDOR_COLORS[inferredVendorId] ?? '#f0f4ff' : 'var(--color-kumo-tint)' }}
    >
      {Logo ? (
        <Logo size={size} />
      ) : (
        <span className="text-[11px] font-medium text-kumo-strong">
          {(bindingName || inferredVendorId || '?')[0].toUpperCase()}
        </span>
      )}
    </div>
  )
}
