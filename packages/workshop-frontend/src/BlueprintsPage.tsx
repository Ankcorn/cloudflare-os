import { Link } from "@tanstack/react-router";
import { Button, useKumoToastManager } from "@cloudflare/kumo";
import {
  UploadSimple,
  Hexagon,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  BlueprintLibrarySummary,
  BlueprintPublicInfo,
  BlueprintUserSummary,
} from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "./AuthContext";
import {
  BlueprintCard,
  getGradient,
} from "./components/BlueprintCard";

export default function BlueprintsPage() {
  const { authenticatedApi } = useAuthenticatedApi();
  const toasts = useKumoToastManager();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const [featuredBlueprints, setFeaturedBlueprints] = useState<
    BlueprintPublicInfo[]
  >([]);
  const [myBlueprints, setMyBlueprints] = useState<BlueprintUserSummary[]>([]);
  const [libraryBlueprints, setLibraryBlueprints] = useState<
    BlueprintLibrarySummary[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const loadBlueprints = useCallback(async () => {
    setLoading(true);
    try {
      const [featured, mine, library] = await Promise.all([
        authenticatedApi.listFeaturedBlueprints(),
        authenticatedApi.listOwnBlueprints(),
        authenticatedApi.listLibraryBlueprints(),
      ]);
      setFeaturedBlueprints(featured);
      setMyBlueprints(mine);
      setLibraryBlueprints(library);
    } catch (err) {
      console.error("Failed to load blueprints page:", err);
      toastsRef.current.add({
        title: "Failed to load blueprints",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [authenticatedApi]);

  useEffect(() => {
    loadBlueprints();
  }, [loadBlueprints]);

  const openUploadPicker = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleBlueprintSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      setUploading(true);
      try {
        await authenticatedApi.importBlueprint(
          file.stream() as ReadableStream<Uint8Array>,
        );
        toastsRef.current.add({
          title: "Blueprint uploaded",
          variant: "success",
        });
        await loadBlueprints();
      } catch (err) {
        console.error("Failed to upload blueprint:", err);
        toastsRef.current.add({
          title: "Failed to upload blueprint",
          variant: "error",
        });
      } finally {
        setUploading(false);
      }
    },
    [authenticatedApi, loadBlueprints],
  );

  // Merge featured + library into one list for the Blueprints section, deduped by ID.
  // Featured come first, then library entries that aren't already featured.
  const allBlueprints = useMemo(() => {
    const featuredIds = new Set(featuredBlueprints.map((b) => b.id));
    return [
      ...featuredBlueprints.map((b) => ({
        id: b.id,
        metadata: b.metadata,
        featured: true,
      })),
      ...libraryBlueprints
        .filter((b) => !featuredIds.has(b.id))
        .map((b) => ({
          id: b.id,
          metadata: b.metadata,
          featured: false,
        })),
    ];
  }, [featuredBlueprints, libraryBlueprints]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <input
        ref={uploadInputRef}
        type="file"
        accept=".gadget"
        className="hidden"
        onChange={handleBlueprintSelected}
      />

      <section>
        <h1 className="text-2xl font-semibold text-kumo-default">Blueprints</h1>
        <p className="mt-2 text-sm text-kumo-subtle max-w-2xl">
          Browse featured picks, keep track of the blueprints you publish, and
          manage your personal library.
        </p>
      </section>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Blueprints — merged featured + library */}
          <section className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-kumo-default">
                  Blueprints
                </h2>
                <p className="text-sm text-kumo-subtle">
                  Featured picks and your saved blueprints.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={openUploadPicker}
                loading={uploading}
                icon={UploadSimple}
              >
                Upload
              </Button>
            </div>
            {allBlueprints.length === 0 ? (
              <EmptySection message="No blueprints yet." />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {allBlueprints.map((blueprint) => (
                  <BlueprintCard
                    key={blueprint.id}
                    id={blueprint.id}
                    metadata={blueprint.metadata}
                    featured={blueprint.featured}
                  />
                ))}
              </div>
            )}
          </section>

          {/* My Blueprints */}
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-kumo-default">
                My Blueprints
              </h2>
              <p className="text-sm text-kumo-subtle">
                Blueprints you published from your own gadgets.
              </p>
            </div>
            {myBlueprints.length === 0 ? (
              <EmptySection message="You haven't published any blueprints yet." />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {myBlueprints.map((blueprint) => (
                  <MyBlueprintCard key={blueprint.id} blueprint={blueprint} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function MyBlueprintCard({ blueprint }: { blueprint: BlueprintUserSummary }) {
  return (
    <div className="relative isolate group rounded-xl border border-kumo-line bg-kumo-elevated transition-colors hover:border-kumo-brand/40 hover:bg-kumo-base flex flex-col min-h-[108px]">
      <Link
        to="/blueprint/$id"
        params={{ id: blueprint.id }}
        aria-label={`Open blueprint ${blueprint.title}`}
        className="absolute inset-0 rounded-xl z-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
      />
      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Icon + title row */}
        <div className="flex items-start gap-3">
          <div
            className={`w-9 h-9 rounded-lg bg-gradient-to-br ${getGradient(blueprint.id)} flex items-center justify-center flex-shrink-0`}
          >
            <Hexagon size={14} className="text-white/70" weight="bold" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-kumo-default leading-snug line-clamp-2">
              {blueprint.title}
            </p>
            <p className="mt-1 text-xs text-kumo-subtle">
              From{" "}
              {blueprint.gadgetTitle === "Deleted Gadget" ? (
                <span>{blueprint.gadgetTitle}</span>
              ) : (
                <Link
                  to="/gadget/$id"
                  params={{ id: blueprint.gadgetId }}
                  className="relative z-10 pointer-events-auto text-kumo-default hover:text-kumo-brand"
                >
                  {blueprint.gadgetTitle}
                </Link>
              )}
            </p>
          </div>
        </div>

        {/* Version info */}
        <p className="text-[11px] text-kumo-subtle">
          v{blueprint.version} ·{" "}
          {new Date(blueprint.lastUpdated).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}

function EmptySection({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-kumo-line bg-kumo-elevated px-4 py-8 text-center text-sm text-kumo-subtle">
      {message}
    </div>
  );
}
