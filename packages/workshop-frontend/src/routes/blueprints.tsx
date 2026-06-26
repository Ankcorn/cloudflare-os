import { createFileRoute, Link } from '@tanstack/react-router'
import { Compass } from '@phosphor-icons/react'
import BlueprintList from '../components/BlueprintList'
import { formatDocumentTitle, useDocumentTitle } from '../useDocumentTitle'

// "Blueprints" — the user's own + saved blueprints, laid out like the Workspaces page. Discovering
// new blueprints lives on the separate Explore page (linked here and from the rail's bottom nav).
export const Route = createFileRoute('/blueprints')({
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  useDocumentTitle(formatDocumentTitle('Blueprints'))
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-3 pt-10">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Blueprints</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Reusable starting points you've published or saved. Spin up a workspace from any of them.
          </p>
        </div>
        <Link
          to="/explore"
          className="press inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-3.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint"
        >
          <Compass size={14} />
          Explore
        </Link>
      </header>
      <div className="min-h-0 flex-1">
        <BlueprintList />
      </div>
    </div>
  )
}
