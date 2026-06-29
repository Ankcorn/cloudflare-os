import { createFileRoute } from '@tanstack/react-router'
import { Clock } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'

// Scheduled Tasks. The feature itself isn't built yet — it'll surface cron / event-triggered runs
// of workspaces (per overview.md). Until then this page shows a frosted design mock so the rail nav
// has a stable, on-language target.
export const Route = createFileRoute('/scheduled')({
  component: ScheduledPage,
})

interface ScheduledTask {
  id: string
  name: string
  workspace: string
  cadence: string
  next: string
  active: boolean
}

const MOCK_TASKS: ScheduledTask[] = [
  { id: '1', name: 'Daily standup digest', workspace: 'Team Copilot', cadence: 'Every weekday at 9:00 AM', next: 'Tomorrow, 9:00 AM', active: true },
  { id: '2', name: 'Weekly metrics report', workspace: 'Revenue Ops', cadence: 'Mondays at 8:00 AM', next: 'Mon, 8:00 AM', active: true },
  { id: '3', name: 'Customer health check', workspace: 'Success Copilot', cadence: 'Every Tuesday at 10:00 AM', next: 'Tue, 10:00 AM', active: true },
  { id: '4', name: 'Nightly data sync', workspace: 'Data Warehouse', cadence: 'Every day at 2:00 AM', next: 'Tonight, 2:00 AM', active: true },
  { id: '5', name: 'Monthly invoice run', workspace: 'Finance Copilot', cadence: '1st of each month at 6:00 AM', next: 'Jul 1, 6:00 AM', active: false },
  { id: '6', name: 'Sprint summary', workspace: 'Product', cadence: 'Fridays at 4:00 PM', next: 'Fri, 4:00 PM', active: true },
]

function TaskRow({ task }: { task: ScheduledTask }) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Clock size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{task.name}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {task.cadence} · {task.workspace}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        Next: {task.next}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] tracking-[-0.2px] text-kumo-subtle">
        <span className={`h-1.5 w-1.5 rounded-full ${task.active ? 'bg-[#2a8e3a]' : 'bg-kumo-inactive'}`} />
        {task.active ? 'Active' : 'Paused'}
      </span>
    </div>
  )
}

function ScheduledPage() {
  useDocumentTitle('Scheduled tasks')
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="px-3 pb-4 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Scheduled tasks</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Run a workspace automatically on a recurring schedule. Enable, pause, and review each
          schedule's runs here.
        </p>
      </header>

      <ComingSoonPreview
        icon={Clock}
        title="Scheduled tasks are coming soon to Gadgets"
        description="A preview of how you'll put a workspace on a recurring schedule, then track each run."
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {MOCK_TASKS.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
