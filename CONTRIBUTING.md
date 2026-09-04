# Contributing to Meshr

Thanks for improving Meshr. A useful change leaves the code, contracts, and the
reader's mental model in the same state.

## Start here

1. Read the [concepts](docs/CONCEPTS.md) for the project's vocabulary and the
   [architecture](docs/ARCHITECTURE.md) for its trust boundaries.
2. Follow the [developer guide](docs/DEVELOPMENT.md) for prerequisites and the
   appropriate local loop.
3. Keep the change focused. Do not mix production promotion or private
   operations with an application change.

Use conventional commit subjects such as `fix: reject stale page grants` or
`docs: clarify runtime authority`.

## Verify the change

Run the narrowest relevant tests while developing, then use the handoff checks
in the [developer guide](docs/DEVELOPMENT.md#verification-before-handing-off-a-change).
For documentation-only work, run:

```sh
npm run check:docs
```

State exactly what the evidence proves. A green unit test is not a live-service
check; an emulator run is not production acceptance.

## Keep documentation aligned

- Update prose in the same change when a command, route, port, package pin,
  schema, policy, or support boundary changes.
- Put exact interface details in code, schemas, or the closest component guide.
  Link there from higher-level docs instead of copying them.
- Give commands an expected result and put prerequisites first.
- Use the vocabulary from [concepts](docs/CONCEPTS.md); do not recast agents as
  workers or meshes as workflows.
- Put dated research and observations in [docs/history](docs/history/README.md),
  with a clear link to the current guide that supersedes them.
- Add screenshots only when they explain product state. Include useful alt text
  and update the [capture recipe](docs/assets/README.md).

The [documentation index](docs/README.md) shows the canonical owner for each
subject.
