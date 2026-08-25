# Workshop agent evals

These evals start the production Workshop under local workerd, ask its agent to build a Gadget, and
check the result through the Gadget's real RPC. `vitest-evals` provides the terminal reporter, JSON
result, local report UI and GitHub report.

`pnpm test` never runs a model. Live evals run only through the explicit commands below.

## Run

Use an existing AI Gateway:

```sh
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_ACCOUNT_ID=...
export CF_AI_GATEWAY_API_TOKEN=...
pnpm evals
```

Or call Workers AI directly:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
pnpm evals
```

Optional controls:

```sh
export WORKSHOP_EVAL_MODELS='@cf/zai-org/glm-5.2,@cf/moonshotai/kimi-k2.7-code'
export WORKSHOP_EVAL_TRIALS=3
export WORKSHOP_EVAL_GATING_TASKS='appointment-desk,project-doc'
```

The defaults are both models, one trial, and every task gating the process. An empty
`WORKSHOP_EVAL_GATING_TASKS` value makes the run reporting-only.

A **turn** is one user prompt followed by the top-level agent remaining idle for two seconds. Turns
in one task share a chat and workspace. Persistent callbacks that start after the idle window are not
covered by the current driver.

A **trial** is one complete execution of every turn and check in a task with one model.
`WORKSHOP_EVAL_TRIALS=3` repeats each task-and-model pair three times.

## Results

The run prints failures and writes `.wrangler/evals/results.json`. Open it with:

```sh
pnpm evals:ui
```

Each trial records raw values for:

- passed, failed and total behavioral checks, with evidence from each check
- total duration, agent duration per turn and verification duration per turn
- model turns, tool calls and tool errors
- agent and provider errors from canonical chat history
- tokens reported for the final model step and cumulative agent-chat cost, when available
- the complete normalized transcript and trace timings
- model, trial, Git commit and task version

`taskVersion` is a SHA-256 hash of the prompts. The Git commit identifies the local Workshop,
agent, verifier and runner used in the trial. Scores come from deterministic checks, not an LLM
judge.

## Add an eval

Add `evals/<name>.eval.ts` and register a task with `defineTaskEval()`:

```ts
const task = defineEvalTask({
  id: "counter",
  turns: [{
    prompt: "Build a Gadget named Counter with increment() and value() RPC methods.",
    verify: async verifier => {
      await verifier.check("increments", async () => {
        using counter = await verifier.connect<CounterApi>("Counter");
        await counter.increment();
        const value = await counter.value();
        return { pass: value === 1, evidence: { value } };
      });
    },
  }],
});

defineTaskEval(task);
```

Checks should verify requested behavior without prescribing the implementation. A later turn should
re-check earlier behavior that its change could break.

## CI

The manual **Workshop evals** workflow runs the same `pnpm evals` command under local workerd,
uploads the JSON result and publishes one GitHub report. It uses repository AI Gateway credentials
for model inference; it does not connect to a deployed Workshop.
