/// <reference types="vite/client" />

// Stub declarations for Cloudflare Workers types used by the shared package.
// The frontend compiles @gadgets/workshop-shared source via path aliases, so it needs
// minimal type stubs for server-side types that appear in the shared interfaces.

declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {}
  export class DurableObject<Env = unknown, Props = unknown> {}
  export class RpcTarget {}
  export type RpcStub<T> = T;
}

declare type Fetcher<T = unknown> = import('capnweb').RpcStub<T>;
declare interface DurableObjectClass<T = unknown> {}
