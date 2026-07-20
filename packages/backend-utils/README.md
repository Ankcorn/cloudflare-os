# Backend utilities

`@gadgets/backend-utils` is a shared library for code that runs in Cloudflare Workers. It is not a
standalone Worker and has no deployable entrypoint or Wrangler project configuration.

The package's Vitest configuration uses the Workers test pool to exercise runtime-specific APIs.
Consumers that import `@gadgets/backend-utils/context-logger` must enable `nodejs_als` (or
`nodejs_compat`); the default `@gadgets/backend-utils/logger` entry point has no such requirement.
