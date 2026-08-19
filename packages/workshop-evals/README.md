# Workshop agent evals

Measures what the Workshop agent actually delivers. Each eval gives the production agent a prompt in
a fresh workerd Workshop, then verifies the Gadget it built by calling that Gadget's own RPC.

This is not a unit test of the agent loop. It is a question about outcomes: *given this ask, does a
working thing come out?* Nothing here asserts which tools the agent used or in what order — an agent
that reaches a working result by an unexpected route passes, which is the point.

## Running

Needs a Cloudflare account with AI Gateway, and Workers AI access for the models under test:

```sh
pnpm build                            # the harness boots the real backend, whose codegen is gitignored

export CLOUDFLARE_ACCOUNT_ID=...      # account owning the Gateway
export CLOUDFLARE_API_TOKEN=...       # AI Gateway Run + Read
export WORKSHOP_EVAL_GATEWAY_ID=...   # Gateway to route and bill through

cd packages/workshop-evals
pnpm eval:required   # tasks expected to pass          -> .wrangler/evals/required.json
pnpm eval:frontier   # tasks tracking what it can't do -> .wrangler/evals/frontier.json
pnpm eval            # everything                      -> .wrangler/evals/results.json
pnpm eval:summary .wrangler/evals/required.json        # aggregate one report
```

`pnpm build` is a one-time prerequisite per checkout, and again after changing the backend. Each
entry point writes its own report so running two in sequence does not leave a summary covering only
the second.

Evals are never part of `pnpm test`: they cost real inference and take minutes per trial. Only the
unit tests in `src/` and `tasks/` run there.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKSHOP_EVAL_MODELS` | GLM 5.2, Kimi K2.7 Code | Comma-separated agent models |
| `WORKSHOP_EVAL_TRIALS` | 3 | Repetitions per task and model |
| `WORKSHOP_EVAL_RUN_ID` | random | Prefix used to attribute Gateway logs |
| `WORKSHOP_EVAL_SHARD` | unset | `2/4` to run one quarter of the runs, for CI fan-out |
| `WORKSHOP_EVAL_WAI_DIRECT` | unset | `true` bypasses Gateway routing for a local smoke run |

`WORKSHOP_EVAL_WAI_DIRECT=true` lets a Wrangler OAuth token drive a run without Gateway permissions.
It also gives up log collection, so token, time, and cost come back marked incomplete and the
summary says so rather than reporting zeros as though they were measurements.

## Writing an eval

Two steps: add `tasks/<id>.ts`, then list it in `tasks/index.ts`. `registry.test.ts` fails if you
forget the second, and the filename must match the task ID.

```ts
import { defineEvalTask } from "../src/task.js";

interface CounterApi {
  increment(input: { by: number }): Promise<{ value: number }>;
}

export default defineEvalTask({
  id: "counter",
  title: "Counter",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Counter" that counts things.
It also needs a stable server RPC taking and returning plain data, so I can verify it:
- increment({ by: integer }) -> { value: number }, the running total after adding by`,
    verify: async verifier => {
      await verifier.check("accumulates", async () => {
        using api = await verifier.connect<CounterApi>("Counter");
        await api.increment({ by: 2 });
        const total = await api.increment({ by: 3 });
        return { pass: total.value === 5, evidence: total };
      });
    },
  }],
});
```

What makes a task work:

- **Name the Gadget exactly.** `verifier.connect(title)` resolves by title, and its error lists what
  was actually built when the agent picked a different name.
- **Ask for a plain-data RPC in the prompt.** That is the verification surface. Without it there is
  nothing to check but source text.
- **Assert behaviour, not implementation.** Check that the arithmetic is right and the edge case is
  handled, not that some particular file exists.
- **Bind connections with `using`.** `connect` hands back a caller-owned stub that holds a session
  open. Individual RPC *results* need no such care here; they are released with the workerd instance
  at the end of the trial.
- **A throw inside `check` is a failed check**, not a crashed run, so the other checks still report.
  A throw *outside* one — an unguarded helper, a duplicate check ID — is recorded as `verifier.threw`
  and the observations already made survive.
- `evidence` is anything JSON-shaped; the framework normalizes it, so handing back an RPC result
  directly is fine.

`expectation` decides whether a failure gates CI. `required` means a failure is a regression;
`frontier` records the score and never fails, which is how a task for capability the agent does not
have yet lives in the suite without turning the build permanently red.

Tier from measurement, never from a guess. A task belongs in `required` once it has passed every
trial that actually ran, and drops to `frontier` when it does not — with the observed failure written
into its doc comment, so the next person knows what to look for rather than re-deriving it. Every
tier here was set this way; §Baseline records the evidence.

Multi-turn tasks take more than one entry in `turns`, sharing one workspace and one chat. The
interesting thing to assert in a later turn is that the *earlier* turn's contract still holds —
see `tasks/reading-list.ts`, where building tagging must not break finishing a book.

## Reading results

`eval:summary <report.json> [name]` writes `.wrangler/evals/<name>.json` and `<name>.md`, and prints:

```
Task              Model                       Pass   95% CI  Score  Tokens  Wall p50     Cost  Tool fail  Invalid
Expense splitter  @cf/zai-org/glm-5.2          3/3  [44, 100]  1.00   38.2k       62s  $0.0431       0.0%        0
Reading list      @cf/zai-org/glm-5.2          2/3   [21, 94]  0.83   61.7k       98s  $0.0702      33.3%        0
```

- **Pass** counts trials where every check passed. **Score** is the mean fraction of checks passed,
  so a task that half-works is visibly different from one that does not work.
- **95% CI** is a Wilson interval. At three trials it is very wide; that is honest, not a defect.
  Raise `WORKSHOP_EVAL_TRIALS` to say anything firm about a difference between two models.
- **Tool fail** is the fraction of trials with a failed tool call. It never affects pass or score —
  an agent that recovered still delivered — but a rate that climbs is usually a platform bug. The
  baseline run surfaced one this way: `executeCode` importing `node:assert`, which the sandbox has
  no module for.
- **Invalid** counts trials that produced no usable result. They are excluded from every rate above,
  so infrastructure trouble reads as missing data rather than as a bad model. A run whose agent
  errored without ever calling a tool — an expired token, a provider outage — is unscored for the
  same reason, rather than counted as a zero. Trouble *after* the
  last check — a Gateway hiccup, a failed source write — does not invalidate a trial whose verdict
  was already known; it lands in `diagnostics.harnessWarnings` and, for telemetry, drops that trial
  out of the token/time/cost columns.

Each trial also leaves `.wrangler/evals/runs/<task>/<model>/trial-<n>/` holding the canonical
transcript and the accepted source of every Gadget, which is where to look when a check fails.

## Baseline

One trial per task against `@cf/zai-org/glm-5.2`, in local direct mode, at the commit that added
them. Thin evidence — enough to tier honestly, not enough to compare models.

| Task | Trials | Result |
| --- | ---: | --- |
| `expense-ledger` | 1 | passes (2 turns, 23 tool calls, ~7 min) |
| `pantry-kitchen` | 1 | passes (24 tool calls, ~7 min) |
| `appointment-desk` | 1 | passes — no overselling under 10 concurrent bookings |
| `spaced-repetition` | 1 | passes — full SM-2 trace including the 1.3 ease floor |
| `org-chart` | 2 | passes |
| `time-tracker` | 3 | **1 of 3.** Closed instead of half-open intervals; duplicate id accepted |

Two things worth knowing about how that baseline was reached, because both shaped the design:

- The `appointment-desk` pass came from a technique nobody prescribed: the agent made the capacity
  check and the insert one synchronous SQL sequence with no `await` between them, then added a
  `BEFORE INSERT` trigger as a second line of defence. A check that asserted *how* to serialize
  would have failed a correct answer. This is why nothing here inspects the agent's method.
- The one `expense-ledger` failure in the first run was a bug in the *task*, not the agent: a
  redundant relational assertion whose algebra was simply wrong, sitting next to correct constants.
  A task's arithmetic deserves its own reference check before it is believed.

## What this does not do

There is no judging of visual quality. A screenshot graded by a model would need its own fidelity
measurement before any number it produced could be trusted, and that work has not been done. Every
number here comes from running the agent's own code and observing what it returns.
