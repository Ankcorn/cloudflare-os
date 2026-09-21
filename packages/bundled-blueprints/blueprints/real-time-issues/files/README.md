# Real-Time Issues Investigator

This Gadget registers a plain local webhook hook and starts an Agent Spawner investigation for each
new event. The webhook payload is treated as untrusted evidence.

Call `install()` once after the Blueprint bindings have been connected. Installation is idempotent;
the user still needs to approve and enable the hook in Cloudflare OS.
