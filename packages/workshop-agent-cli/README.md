# Workshop Agent CLI

Runs one prompt against an ephemeral local Workshop and accepts the agent's changes.

```sh
printf '%s\n' 'Build a weather dashboard' | pnpm workshop-agent --model @cf/example/model
```

`--model` is required. `--output <directory>` writes each Gadget's source tree and `result.json`.
The output directory must not exist, and its parent directory must already exist. Without `--output`,
stdout contains one JSON result with source text inline. Progress and errors go to stderr.

The CLI reads `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, and `CF_AI_GATEWAY_API_TOKEN` from the
environment. `CF_AI_GATEWAY_WAI_DIRECT=true` enables the product's direct Workers AI mode. Tokens
are never accepted on the command line.

Exit codes are `0` for completion, `1` for agent or runtime failure, `2` for usage or configuration
errors, and `130` for cancellation.

This is a single-turn local runner. It does not provide a REPL, persistence, deployed login, host
repository access, shell or filesystem tools, ACP/Harbor formats, screenshots, judging, or metrics.
