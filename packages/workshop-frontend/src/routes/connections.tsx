import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import { Button, Dialog, DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import {
  MagnifyingGlass,
  ArrowsClockwise,
  PlugsConnected,
  Plug,
  Plus,
  CaretDown,
  Sparkle,
} from "@phosphor-icons/react";
import { useAuthenticatedApi } from "../AuthContext";
import { logoComponents } from "../components/ConnectionLogos";
import {
  VendorDescription,
  AccountDescription,
  SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { ConnenctedAccountsSubscriber } from "@gadgets/workshop-shared/api";
import { RpcTarget } from "capnweb";

export const Route = createFileRoute("/connections")({
  component: ConnectionsPage,
});

// Maps RPC vendor IDs to logo keys in our logoComponents map
const VENDOR_LOGO_MAP: Record<string, string> = {
  slack: "slack",
  discord: "discord",
  jira: "jira",
  google: "google",
  github: "github",
  notion: "notion",
  linear: "linear",
  figma: "figma",
};

function getVendorColor(vendorId: string): string {
  const colors: Record<string, string> = {
    slack: "#f4ecf5",
    discord: "#eef0ff",
    jira: "#e6efff",
    google: "#e8f0fe",
    github: "#f0f0f0",
    notion: "#f5f5f5",
    linear: "#eeeffa",
    figma: "#fef0ec",
  };
  return colors[vendorId] ?? "#f0f4ff";
}

interface AccountEntry {
  id: number;
  accountDescription: AccountDescription;
  vendorId: string;
  vendorDescription: VendorDescription;
  logoKey: string;
  bgColor: string;
  credentialsValid: boolean;
}

interface VendorEntry {
  id: string;
  description: VendorDescription;
  supportedResources: SupportedResource[];
  logoKey: string;
  bgColor: string;
}

function ConnectedAccountCard({
  account,
  onDisconnect,
  onReconnect,
}: {
  account: AccountEntry;
  onDisconnect: () => void;
  onReconnect: () => void;
}) {
  const Logo = logoComponents[account.logoKey];
  const displayName =
    account.accountDescription.displayName ??
    account.accountDescription.uniqueName ??
    "Connected";
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base p-4 hover:border-kumo-fill transition-colors">
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: account.bgColor }}
        >
          {Logo ? (
            <Logo size={20} />
          ) : (
            <span className="text-sm font-bold text-kumo-strong">
              {account.vendorDescription.displayName[0]}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-kumo-default">
              {account.vendorDescription.displayName}
            </span>
          </div>
          <p className="text-xs text-kumo-subtle mt-0.5 truncate">
            {displayName}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-kumo-fill">
        {account.credentialsValid ? (
          <>
            <span className="flex items-center gap-1 text-xs text-kumo-subtle">
              <PlugsConnected size={14} />
              Connected
            </span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 text-xs text-kumo-subtle">
              <Plug size={14} />
              Credentials expired
            </span>
            <Button variant="primary" size="xs" onClick={onReconnect}>
              <ArrowsClockwise size={12} className="mr-1" />
              Reconnect
            </Button>
          </>
        )}
      </div>

      <Dialog.Root role="alertdialog" open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            Disconnect {account.vendorDescription.displayName}?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            Gadgets using this connection will no longer be able to access it and may stop working.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close render={(props) => (
              <Button variant="secondary" {...props}>Cancel</Button>
            )} />
            <Button variant="destructive" onClick={() => { setConfirmOpen(false); onDisconnect(); }}>
              Disconnect
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

function AddConnectionMenu({
  vendors,
  onConnect,
  triggerLabel = "Add connection",
}: {
  vendors: VendorEntry[];
  onConnect: (vendorId: string) => void;
  triggerLabel?: string;
}) {
  const sortedVendors = useMemo(
    () =>
      [...vendors].sort((a, b) =>
        a.description.displayName.localeCompare(b.description.displayName),
      ),
    [vendors],
  );

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="primary" size="base">
            <Plus size={16} className="mr-1.5" />
            {triggerLabel}
            <CaretDown size={14} className="ml-1.5 opacity-70" />
          </Button>
        }
      />
      <DropdownMenu.Content
        align="end"
        sideOffset={6}
        className="min-w-[280px] max-h-[60vh] overflow-y-auto p-1"
      >
        {sortedVendors.length === 0 ? (
          <div className="px-3 py-2 text-xs text-kumo-subtle">
            No connection types available.
          </div>
        ) : (
          sortedVendors.map((vendor) => {
            const Logo = logoComponents[vendor.logoKey];
            return (
              <DropdownMenu.Item
                key={vendor.id}
                onClick={() => onConnect(vendor.id)}
                className="!h-auto !px-2 !py-2 !text-sm"
                icon={
                  <div
                    className="mr-3 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border border-kumo-line/60"
                    style={{ backgroundColor: vendor.bgColor }}
                  >
                    {Logo ? (
                      <Logo size={16} />
                    ) : (
                      <span className="text-[11px] font-bold text-kumo-strong">
                        {vendor.description.displayName[0]}
                      </span>
                    )}
                  </div>
                }
              >
                <span className="font-medium text-kumo-default">
                  {vendor.description.displayName}
                </span>
              </DropdownMenu.Item>
            );
          })
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function EmptyState({
  vendors,
  onConnect,
}: {
  vendors: VendorEntry[];
  onConnect: (vendorId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-kumo-line bg-kumo-elevated/40 py-16 px-6 flex flex-col items-center text-center">
      <div className="relative mb-5">
        <div className="w-16 h-16 rounded-2xl bg-kumo-base border border-kumo-line flex items-center justify-center shadow-sm">
          <PlugsConnected size={28} className="text-kumo-brand" weight="duotone" />
        </div>
        <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-kumo-base border border-kumo-line flex items-center justify-center">
          <Sparkle size={12} weight="fill" className="text-kumo-brand" />
        </div>
      </div>
      <h2 className="text-lg font-semibold text-kumo-default">
        Connect your first service
      </h2>
      <p className="mt-2 text-sm text-kumo-subtle max-w-md">
        Link accounts like Google, GitHub, Slack and more so your Gadgets can read,
        write and act on your behalf — all within a sandboxed connection you control.
      </p>
      <div className="mt-6">
        <AddConnectionMenu
          vendors={vendors}
          onConnect={onConnect}
          triggerLabel="Add your first connection"
        />
      </div>
    </div>
  );
}

function ConnectionsPage() {
  const { authenticatedApi } = useAuthenticatedApi();
  const toasts = useKumoToastManager();
  const [search, setSearch] = useState("");
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [vendors, setVendors] = useState<VendorEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [accountsReady, setAccountsReady] = useState(false);
  const subscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const accountMap = new Map<number, AccountEntry>();

    // Reset state so that a re-run (e.g. authenticatedApi changing after
    // re-auth) doesn't briefly show stale accounts, a stale empty state, or a
    // stale error banner before the fresh data arrives.
    setAccounts([]);
    setVendors([]);
    setAccountsReady(false);
    setLoadError(false);

    // Load vendors
    authenticatedApi
      .listGatekeeperVendors()
      .then((vendorList) => {
        if (cancelled) return;
        setVendors(
          vendorList.map((v) => ({
            id: v.id,
            description: v.description,
            supportedResources: v.supportedResources,
            logoKey: VENDOR_LOGO_MAP[v.id] ?? v.id.toLowerCase(),
            bgColor: getVendorColor(v.id),
          })),
        );
      })
      .catch((err) => {
        console.error('Failed to load available services:', err)
        if (!cancelled) setLoadError(true)
      });

    // Subscribe to connected accounts using RpcTarget so Cap'n Web passes it by reference
    class AccountsSubscriber
      extends RpcTarget
      implements ConnenctedAccountsSubscriber
    {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        _supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        if (cancelled) return;
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorId,
          vendorDescription: vendor,
          logoKey: VENDOR_LOGO_MAP[vendorId] ?? vendorId,
          bgColor: getVendorColor(vendorId),
          credentialsValid,
        });
        setAccounts(Array.from(accountMap.values()));
      }
      remove(id: number) {
        accountMap.delete(id);
        if (!cancelled) setAccounts(Array.from(accountMap.values()));
      }
      ready() {
        if (!cancelled) setAccountsReady(true);
      }
    }

    const subscriber = new AccountsSubscriber();

    authenticatedApi
      .subscribeConnectedAccounts(subscriber)
      .then((stub) => {
        if (cancelled) {
          stub[Symbol.dispose]();
        } else {
          subscriptionRef.current = stub;
        }
      })
      .catch((err) => {
        console.error('Failed to subscribe to connected accounts:', err)
        if (!cancelled) setLoadError(true)
      });

    return () => {
      cancelled = true;
      subscriptionRef.current?.[Symbol.dispose]();
      // Null the ref so React Strict Mode's double-invoked cleanup doesn't
      // double-dispose the same stub.
      subscriptionRef.current = null;
    };
  }, [authenticatedApi]);

  const handleConnect = async (vendorId: string) => {
    try {
      const { url } = await authenticatedApi.connectAccount(vendorId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("Failed to connect account:", err);
      toasts.add({ title: 'Failed to start connection', variant: 'error' });
    }
  };

  const handleDisconnect = async (accountId: number) => {
    try {
      await authenticatedApi.disconnectAccount(accountId);
    } catch (err) {
      console.error("Failed to disconnect account:", err);
      toasts.add({ title: 'Failed to disconnect account', variant: 'error' });
    }
  };

  const handleReconnect = async (accountId: number) => {
    try {
      const { url } = await authenticatedApi.reconnectAccount(accountId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("Failed to reconnect account:", err);
      toasts.add({ title: 'Failed to reconnect account', variant: 'error' });
    }
  };

  const searchLower = search.trim().toLowerCase();
  const filteredAccounts = accounts.filter((a) => {
    if (!searchLower) return true;
    const name = a.accountDescription.displayName ?? a.accountDescription.uniqueName ?? '';
    return (
      a.vendorDescription.displayName.toLowerCase().includes(searchLower) ||
      name.toLowerCase().includes(searchLower)
    );
  });

  const hasAccounts = accounts.length > 0;
  const showEmptyState = accountsReady && !loadError && !hasAccounts;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-kumo-default">
            Connections
          </h1>
          <p className="text-sm text-kumo-subtle mt-1">
            Manage your data sources and what Gadgets can access.
          </p>
        </div>
        {hasAccounts && (
          <div className="flex-shrink-0">
            <AddConnectionMenu vendors={vendors} onConnect={handleConnect} />
          </div>
        )}
      </div>

      {hasAccounts && (
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search connections..."
            className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand"
          />
        </div>
      )}

      {hasAccounts && (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredAccounts.map((account) => (
            <ConnectedAccountCard
              key={account.id}
              account={account}
              onDisconnect={() => handleDisconnect(account.id)}
              onReconnect={() => handleReconnect(account.id)}
            />
          ))}
        </div>
      )}

      {hasAccounts && filteredAccounts.length === 0 && (
        <div className="text-center py-12 text-kumo-inactive text-sm">
          No connections match your search.
        </div>
      )}

      {showEmptyState && (
        <EmptyState vendors={vendors} onConnect={handleConnect} />
      )}

      {loadError && !hasAccounts && (
        <div className="text-center py-16 text-sm">
          <p className="text-kumo-danger">Something went wrong loading your connections.</p>
          <p className="text-kumo-subtle mt-1">Check your connection and try refreshing the page.</p>
        </div>
      )}
    </div>
  );
}
