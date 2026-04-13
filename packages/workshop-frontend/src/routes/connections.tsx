import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { MagnifyingGlass, ArrowsClockwise, PlugsConnected, Plug } from "@phosphor-icons/react";
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

function AvailableVendorCard({
  vendor,
  onConnect,
}: {
  vendor: VendorEntry;
  onConnect: () => void;
}) {
  const Logo = logoComponents[vendor.logoKey];

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base p-4 hover:border-kumo-fill transition-colors">
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: vendor.bgColor }}
        >
          {Logo ? (
            <Logo size={20} />
          ) : (
            <span className="text-sm font-bold text-kumo-strong">
              {vendor.description.displayName[0]}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-kumo-default">
              {vendor.description.displayName}
            </span>
          </div>
          <p className="text-xs text-kumo-subtle mt-0.5">
            {vendor.description.url}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-kumo-fill">
        <span className="flex items-center gap-1 text-xs text-kumo-subtle">
          <Plug size={14} />
          Not connected
        </span>
        <Button variant="primary" size="sm" onClick={onConnect}>
          Connect
        </Button>
      </div>
    </div>
  );
}

function ConnectionsPage() {
  const { authenticatedApi } = useAuthenticatedApi();
  const toasts = useKumoToastManager();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "available">(
    "all",
  );
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [vendors, setVendors] = useState<VendorEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const subscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const accountMap = new Map<number, AccountEntry>();

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
      ) {
        if (cancelled) return;
        const vendorId = vendor.displayName.toLowerCase().split(" ")[0];
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
      ready() {}
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

  // Filter vendors that are not already connected
  const connectedVendorIds = new Set(accounts.map((a) => a.vendorId));
  const availableVendors = vendors.filter((v) => !connectedVendorIds.has(v.id));

  const filterOptions: { value: typeof filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "connected", label: "Connected" },
    { value: "available", label: "Available" },
  ];

  const searchLower = search.toLowerCase();
  const filteredAccounts = accounts.filter(
    (a) =>
      !search ||
      a.vendorDescription.displayName.toLowerCase().includes(searchLower),
  );
  const filteredAvailable = availableVendors.filter(
    (v) =>
      !search ||
      v.description.displayName.toLowerCase().includes(searchLower),
  );

  const showDivider =
    filter === "all" &&
    filteredAccounts.length > 0 &&
    filteredAvailable.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">
          Connections
        </h1>
        <p className="text-sm text-kumo-subtle mt-1">
          Manage your data sources and what Gadgets can access.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
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
        <div className="flex items-center gap-1">
          {filterOptions.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                filter === f.value
                  ? "text-kumo-inverse bg-kumo-contrast border-kumo-contrast"
                  : "text-kumo-subtle border-kumo-line hover:text-kumo-default"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(filter === "all" || filter === "connected") &&
          filteredAccounts.map((account) => (
            <ConnectedAccountCard
              key={account.id}
              account={account}
              onDisconnect={() => handleDisconnect(account.id)}
              onReconnect={() => handleReconnect(account.id)}
            />
          ))}

        {showDivider && (
          <hr className="col-span-full border-t border-kumo-line my-2" />
        )}

        {(filter === "all" || filter === "available") &&
          filteredAvailable.map((vendor) => (
            <AvailableVendorCard
              key={vendor.id}
              vendor={vendor}
              onConnect={() => handleConnect(vendor.id)}
            />
          ))}
      </div>

      {loadError && accounts.length === 0 && vendors.length === 0 && (
        <div className="text-center py-16 text-sm">
          <p className="text-kumo-danger">Something went wrong loading your connections.</p>
          <p className="text-kumo-subtle mt-1">Check your connection and try refreshing the page.</p>
        </div>
      )}
      {!loadError && accounts.length === 0 && availableVendors.length === 0 && (
        <div className="text-center py-16 text-kumo-inactive text-sm">
          No connections found
        </div>
      )}
    </div>
  );
}
