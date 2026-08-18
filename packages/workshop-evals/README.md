# Workshop agent evals

This package runs the production Workshop agent in workerd, verifies its provisional Gadget branch
through public RPC capabilities, captures rendered and source artifacts, and records normalized
results for `vitest-evals`.

The package contains the eval infrastructure, required and frontier task suites, and a
static-evidence judge canary. All task scores are advisory until a measured baseline promotes
stable tasks into CI gates.

## Configuration

Live runs require all three variables. Missing or empty values fail the run before workerd starts.

- `CLOUDFLARE_ACCOUNT_ID`: account that owns the AI Gateway
- `CLOUDFLARE_API_TOKEN`: token with Gateway run and log-read permissions
- `WORKSHOP_EVAL_GATEWAY_ID`: Gateway used by the agent and judge
- `WORKSHOP_EVAL_JUDGE_MODEL`: optional judge override; defaults to
  `@cf/deepseek-ai/deepseek-v4-pro-0813`
- `WORKSHOP_EVAL_MODELS`: optional comma-separated agent models; defaults to GLM 5.2 and Kimi K2.7
- `WORKSHOP_EVAL_TRIALS`: positive integer repetitions per task/model; defaults to 10
- `WORKSHOP_EVAL_RUN_ID`: optional unique workflow identifier used for Gateway-log attribution;
  local runs generate one automatically
- `WORKSHOP_EVAL_SEED`: optional safe integer judge seed; defaults to 42
- `WORKSHOP_EVAL_WAI_DIRECT`: optional `true` for local OAuth-token smoke tests that cannot use
  AI Gateway data-plane authentication. Agent Gateway metrics are incomplete in this mode; CI and
  benchmark runs should leave it unset.

The harness retains the checked-in Workshop Worker Loader and Browser binding. Wrangler validates
that configuration and must provide a working browser; screenshot failures are never replaced with
fixtures.

## Commands

```bash
pnpm --filter @gadgets/workshop-evals build
pnpm --filter @gadgets/workshop-evals test:run
pnpm --filter @gadgets/workshop-evals eval:all
pnpm --filter @gadgets/workshop-evals eval:required
pnpm --filter @gadgets/workshop-evals eval:frontier
pnpm --filter @gadgets/workshop-evals eval:canary
pnpm --filter @gadgets/workshop-evals eval:summary
```

`test:run` and the cached Vite+ `test` task include only `src/**/*.test.ts` and
`evals/**/*.test.ts`. Live files use the `evals/**/*.eval.ts` suffix and run through
`vitest.eval.config.ts`, so ordinary `pnpm test` never makes model calls.

The judge canary requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and
`WORKSHOP_EVAL_GATEWAY_ID`. It sends one request per hand-labelled fixture to the fixed
`@cf/deepseek-ai/deepseek-v4-pro-0813` model and fails on transport, response-validation, overall
score-band, or rubric-dimension drift. It is separate from agent tasks and result summaries.

`eval:all` writes canonical Vitest JSON to `.wrangler/evals/results.json`; required and frontier commands
write separate result files. `eval:summary` reads the combined result through `@vitest-evals/core`
and writes `.wrangler/evals/summary.json` and `.wrangler/evals/summary.md`. To summarize a separate
report, pass its path and output stem after `--`, for example `eval:summary --
.wrangler/evals/required-results.json required-summary`. Run artifacts are content-addressed beneath
`.wrangler/evals/artifacts/`; source and
screenshots are represented in run JSON only by path, digest, size, and media type.
