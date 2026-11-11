# npm tag releases

`@fastrd/harness-transport` trusts **FastR-D/FastHarness**, workflow
**publish.yml**, with direct publishing permission. GitHub-hosted Actions uses
OIDC and npm provenance; it does not require a long-lived publishing secret.

1. Update `packages/transport/package.json` to a new version and refresh its
   package-lock using the official npm registry.
2. From `packages/transport`, run `npm ci` and `npm test`.
3. Commit reviewed changes, push main and wait for the Windows/Ubuntu checks.
4. Push the exact matching `vX.Y.Z` tag. The publish workflow validates tag,
   source and package identity, packs once, installs that original archive into
   an external consumer and tests it before publication.
5. Confirm the version, integrity and provenance on public npm and update
   consumers' exact dependency versions and locks.

Partial-run recovery only skips a published version if archive integrity is
identical. A mismatched tag, dirty source, missing verification, changed archive
or conflicting existing version fails; do not overwrite a version or move tags.

Initial 0.1.1 established the npm package and trust configuration through
interactive 2FA. Version 0.1.2 was actually uploaded by the tag-triggered OIDC
workflow, not merely simulated or skipped as an existing version.
