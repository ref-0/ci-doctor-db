# ref-0/ci-doctor-db's commands

What the shared skills read for how to check and test `ref-0/ci-doctor-db`. Run everything from the root.

## Install

pnpm runs the root, `pnpm install --frozen-lockfile`.

## Pre-push set

Before every push, from the root. The pre-push hook runs these, as the root `package.json`'s `"ref0-workspace"."prePush"` names them, each through `vp run --cache`:

1. Format and lint: none of the repo's own. The pre-commit hook runs `vp fmt` on the staged files, not `vp check --fix`: 729 lint errors `--fix` can't fix (measured 28 Nov) would refuse commits.
2. Types: none until the repo has a `tsconfig.json`.
3. Type coverage: none.
4. Docs budget: none. The repo has no `AGENTS.md`, skills or glossary.
5. The changed tests: `pnpm run test`, the `loop/test/` suite.
6. Lint and size tests: none.

Report the commands and their results with the head SHA they ran on. `REF0_SKIP_PUSH_CHECKS=1` skips the push checks, and says so.
