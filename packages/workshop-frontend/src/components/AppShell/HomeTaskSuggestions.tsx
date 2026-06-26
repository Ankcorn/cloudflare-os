import {
  AppWindow,
  ChartLineUp,
  Lightning,
  UsersThree,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running. Kept deliberately short and minimal —
// inspiration, not a catalog.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    label: 'Prep for a 1:1',
    description: 'A pre-read with a snapshot, things to inspect, and one ask',
    icon: UsersThree,
    prompt:
      'Help me prepare an internal pre-read for my next 1:1 with a direct report. Include a current snapshot, a coaching frame, things to inspect, carryover items from last time, and one clear ask.',
  },
  {
    id: 'insights',
    label: 'Find insights in my data',
    description: 'Turn a spreadsheet or CSV into trends and recommendations',
    icon: ChartLineUp,
    prompt:
      'Turn a dataset I will share (a spreadsheet, CSV, or pasted table) into a narrative analysis: key trends, anomalies, the "so what", and concrete recommendations.',
  },
  {
    id: 'workflow',
    label: 'Automate a workflow',
    description: 'Trigger an agent when a new email arrives',
    icon: Lightning,
    prompt:
      'Create an agent workflow that runs automatically when a new email arrives: read the message, decide what to do, and take action or draft a reply. Ask me which inbox to watch and what it should handle.',
  },
  {
    id: 'app',
    label: 'Build a quick tool',
    description: 'A small interactive app, calculator, or dashboard',
    icon: AppWindow,
    prompt:
      'Build a small interactive tool I can use right here — a calculator, dashboard, or explorer. Ask me what it should do, then create it.',
  },
]

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="flex flex-col gap-0.5">
        {SUGGESTIONS.map((s) => {
          const Icon = s.icon
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s.prompt)}
                className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                    {s.label}
                  </span>
                  <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                    {s.description}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
