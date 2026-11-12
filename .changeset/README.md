# Changesets

Every change to a published package (`@debug/schema`, `@debug/sdk`, `@debug/ingest`,
`@debug/adapters`) needs a changeset:

```bash
pnpm changeset
```

Pick the bump (patch / minor / major) and write one line for the changelog. The four
packages are versioned together. On merge to `main`, the Release workflow opens a
"Version packages" PR; merging that PR publishes to npm.
