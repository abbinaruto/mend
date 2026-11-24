# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/abbinaruto/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/abbinaruto/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, to the written specification in SPEC.md. It finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers), and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`), `--check` (dry run: same output and exit code, no files written), `--strict` (tier-0 exact matching only). PATCH is the patch file, or `-`/absent to read from standard input. Exit 0 lists the changed files (`A`/`D`/`M`/`R`), exit 1 lists the edits that failed, exit 2 is a usage, patch-file, format or parse error.

## Check it

```sh
node check.ts <practice.json>
```

runs the CLI on the kit's 100 public practice checks and prints the practice score.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x4x7sknz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
