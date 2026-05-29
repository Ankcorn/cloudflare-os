import { Link } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowRight,
  BookOpen,
  Hexagon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { BlueprintPublicInfo } from "@gadgets/workshop-shared/api";
import { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { useAuthenticatedApi } from "./AuthContext";
import {
  BindingBadge,
  getGradient,
  uniqueBindingBadges,
} from "./components/BlueprintCard";
import { BlueprintPreviewImage } from "./components/BlueprintPreviewImage";

export default function BlueprintsPage() {
  const { authenticatedApi } = useAuthenticatedApi();
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const [featuredBlueprints, setFeaturedBlueprints] = useState<BlueprintPublicInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [vendorDescriptions, setVendorDescriptions] = useState<Map<string, VendorDescription>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      authenticatedApi.listFeaturedBlueprints(),
      authenticatedApi.listGatekeeperVendors(),
    ])
      .then(([featured, vendors]) => {
        if (cancelled) return;
        setFeaturedBlueprints(featured);
        setVendorDescriptions(
          new Map(
            vendors.map((vendor) => [vendor.id.toLowerCase(), vendor.description]),
          ),
        );
      })
      .catch((err) => {
        console.error("Failed to load Explore data:", err);
        toastsRef.current.add({
          title: "Failed to load featured blueprints",
          variant: "error",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  return (
    <div className="relative min-h-[calc(100vh-3.5rem-1px)] overflow-hidden bg-kumo-base">
      <div
        className="pointer-events-none absolute inset-0 h-[320px]"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)",
        }}
      />

      <div className="relative mx-auto w-full max-w-[1040px] px-4 py-12 sm:px-8 sm:py-14">
        <header className="mb-8 max-w-[680px]">
          <h1 className="m-0 text-[32px] leading-[1.05] font-semibold tracking-[-1.2px] text-kumo-default sm:text-[38px]">
            Explore
          </h1>
          <p className="mt-3 max-w-[560px] text-[15px] leading-[22px] font-normal tracking-[-0.25px] text-kumo-subtle">
            Discover featured blueprints you can use as starting points. Create
            your own gadget and save the ones you want to reuse.
          </p>
        </header>

        {loading ? (
          <LoadingPanel />
        ) : featuredBlueprints.length === 0 ? (
          <EmptySection
            title="No featured blueprints yet"
            message="Featured blueprints will appear here when they’re published. You can still create blueprints from your own Gadgets."
            icon={BookOpen}
          />
        ) : (
          <section className="mb-10">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featuredBlueprints.map((blueprint) => (
                <FeaturedBlueprintCard
                  key={blueprint.id}
                  blueprint={blueprint}
                  vendorDescriptions={vendorDescriptions}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-10 text-center">
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      <p className="mt-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
        Loading featured blueprints...
      </p>
    </div>
  );
}

function FeaturedBlueprintCard({
  blueprint,
  vendorDescriptions,
}: {
  blueprint: BlueprintPublicInfo;
  vendorDescriptions: Map<string, VendorDescription>;
}) {
  const badges = uniqueBindingBadges(blueprint.metadata.bindings).slice(0, 2);

  return (
    <div className="group relative isolate flex min-h-[148px] cursor-pointer overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base/90 text-left backdrop-blur-sm transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill hover:shadow-[0_10px_24px_-20px_rgba(82,16,0,0.22)] active:scale-[0.995]">
      <div className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-[rgba(255,72,1,0.08)] blur-2xl" />
      <Link
        to="/blueprint/$id"
        params={{ id: blueprint.id }}
        aria-label={`Open featured blueprint ${blueprint.metadata.title}`}
        className="absolute inset-0 z-10 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
      />

      <div className="pointer-events-none relative z-20 flex h-full w-full flex-col p-3.5">
        <BlueprintPreviewImage
          blueprintId={blueprint.id}
          title={blueprint.metadata.title}
          screenshotUrl={blueprint.screenshotUrl}
          className="mb-3"
        />
        <div className="flex items-start gap-3">
          <div
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${getGradient(blueprint.id)}`}
          >
            <Hexagon size={15} className="text-white/75" weight="bold" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 line-clamp-2 text-[15px] leading-5 font-semibold tracking-[-0.25px] text-kumo-default">
              {blueprint.metadata.title}
            </p>
            <p className={`mt-1 line-clamp-2 min-h-8 text-[12px] leading-4 font-normal tracking-[-0.2px] ${blueprint.metadata.description ? "text-kumo-subtle" : "text-kumo-inactive italic"}`}>
              {blueprint.metadata.description || "No description"}
            </p>
          </div>
        </div>

        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          {badges.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-1">
              {badges.map((badge) => (
                <BindingBadge
                  key={badge.vendorKey ?? badge.type}
                  badge={badge}
                  vendorDescriptions={vendorDescriptions}
                />
              ))}
            </div>
          ) : (
            <span />
          )}
          <ArrowRight
            size={14}
            weight="bold"
            className="shrink-0 text-kumo-inactive opacity-0 transition-[opacity,transform,color] duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-kumo-default group-hover:opacity-100"
          />
        </div>
      </div>
    </div>
  );
}

function EmptySection({
  title,
  message,
  icon: Icon,
}: {
  title: string;
  message: string;
  icon: Icon;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-kumo-line bg-kumo-base px-4 py-8 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-2xl bg-kumo-tint text-kumo-subtle">
        <Icon size={20} weight="duotone" />
      </div>
      <p className="mt-3 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
        {title}
      </p>
      <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
        {message}
      </p>
    </div>
  );
}
