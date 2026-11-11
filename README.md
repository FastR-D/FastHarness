# FastHarness

Published package: `npm install @fastrd/harness-transport@0.1.2`.
See [RELEASING.md](RELEASING.md) for the verified automatic tag release path.

## Automated npm releases

Update `packages/transport/package.json` and its lockfile, test, commit, and push
the matching `vX.Y.Z` tag. `.github/workflows/publish.yml` installs, tests, packs
and publishes via npm Trusted Publishing (GitHub OIDC). Configure the npm package
to trust `FastR-D/FastHarness`, workflow `publish.yml`; no repository publish secret
is needed. An existing version is only accepted if its archive integrity matches.

Shared CLI transport for FastR-D applications. `@fastrd/harness-transport` provides bounded JSONL RPC, pending-request lifetime, cancellation and awaited process cleanup on Node.js 22+.

Applications retain ownership of sandbox arguments, approval policy, user/project authorization, tool permissions, model configuration and domain event interpretation. This package is not an agent scheduler or permission policy.

Install with `npm install @fastrd/harness-transport@0.1.1 --registry=https://registry.npmjs.org/` on Node.js 22 or newer.

Build and test from `packages/transport`: `npm ci && npm test`. Run `npm pack` to build a tarball containing `dist/`, `LICENSE`, `README.md` and package metadata. The package is configured for public publication to the official npm registry. Release authentication, 2FA and tag-triggered publication are managed by the release coordinator.

The transport originates from FastPPT's generic JSONL bridge, authorized by the owner for shared publication. Private assets, model credentials and product workflows are not included.
