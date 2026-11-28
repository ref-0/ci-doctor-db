import { base, merge } from '@ref0/workspace/lint/config';
import { antiSlop, antiSlopEffect, generic, t3code } from '@ref0/workspace/lint/plugins';
import { defineConfig } from 'vite-plus';

// The shared format and lint settings from `@ref0/workspace`, and `vp staged`'s, which the
// pre-commit hook runs: `vp fmt` on the staged files.
export default defineConfig({
  fmt: base.fmt,
  // The shared rules name each of these plugins' rules, so each repo registers them.
  lint: merge(base.lint, { jsPlugins: [antiSlop, antiSlopEffect, t3code, generic] }),
  // `vp fmt` alone, not `base.staged`'s `vp check --fix`: the repo's lint errors that `--fix` can't
  // fix would refuse commits.
  staged: { '*': 'vp fmt' },
});
