# Real-Time Issues Investigator

This Gadget registers a Cloudflare Notification hook for
`observability.issue.automation-triggered` and starts an Agent Spawner investigation for each new
issue. The Agent Spawner receives only the selected Workers Observability and GitHub repository
capabilities. It may open a draft pull request, but it must not merge or deploy.

Call `install()` once after the Blueprint bindings have been connected. Installation is idempotent;
the user still needs to approve and enable the Notification hook in Cloudflare OS.
