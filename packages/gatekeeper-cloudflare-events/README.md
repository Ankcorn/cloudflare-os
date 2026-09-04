# Cloudflare Event Subscriptions Gatekeeper

A standalone Cloudflare OS gatekeeper for account-scoped Cloudflare Event Subscriptions.

Gadgets declare the source and event names they need through `CLOUDFLARE_EVENTS`. The gatekeeper owns Cloudflare OAuth, the managed Queue and HTTP pull consumer, Event Subscription lifecycle, polling, validation, deduplication, acknowledgement and cleanup.

The Queue and OAuth capabilities are not exposed to Gadgets or agents.
