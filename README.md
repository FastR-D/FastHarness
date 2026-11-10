# FastHarness

Shared CLI transport for FastR-D applications. `@fastrd/harness-transport` provides bounded JSONL RPC, pending-request lifetime, cancellation and awaited process cleanup on Node.js 22+.

Applications retain ownership of sandbox arguments, approval policy, user/project authorization, tool permissions, model configuration and domain event interpretation. This package is not an agent scheduler or permission policy.

Build and test from `packages/transport`: `npm ci && npm test`. Packages are distributed as immutable GitHub Release tarballs; npm registry publication requires a separately authorized publisher.

The transport originates from FastPPT's generic JSONL bridge, authorized by the owner for shared publication. Private assets, model credentials and product workflows are not included.
