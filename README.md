To run it, run the client and server dev sessions like:

* `MINIFLARE_WORKERD_PATH=/path/to/minions-experimental/workerd pnpm run dev-server`
* `pnpm run dev-client`

Then visit `localhost:3000`. To log in, enter any username with the password "hunter2".

NOTE: At present you need `workerd` built from [the `kenton/minions-experimental` branch](https://github.com/cloudflare/workerd/tree/kenton/minions-experimental). Hence the need for `MINIFLARE_WORKERD_PATH`.
