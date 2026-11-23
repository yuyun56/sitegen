# sitegen

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yuyun56/sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yuyun56/sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A drop-in replacement for makefun-site 1.0.0, written for make.fun's
site-generator-speed bounty. `solve.js` exports `run(input)`, which returns
exactly the output tree makefun-site's `build` returns for a case's input
(`{ site, templates, files }`): every page's `index.html`, the index and tag
pages, `build-report.txt` and each static file, byte for byte. `main.ts` is
the driver the harness runs: it reads `/input/cases.json`, answers each case
with `run`, and writes `/output/answers.json`.

The dialect is makefun-site's own — its front matter, Markdown subset,
template language, slug rule and report — re-implemented here as single-pass
scanners with no dependencies:

- front matter is located and judged line by line, without splitting the
  whole source more than once;
- Markdown blocks and inline marks are rendered in one pass, plain text
  escaped in bulk runs rather than per character;
- templates are compiled once per build into node trees and rendered by
  walking them, with the same standalone-line and include-depth rules;
- slugs are computed once per distinct text per build (titles, tag names and
  heading texts repeat heavily across a site) and cached;
- the build itself is a straight-line pipeline over plain records — no
  per-file plugin chain, no intermediate token objects.

Correctness is byte-identity with the reference on every case; only then
does the CPU time count.

## Run it

```sh
node main.ts
```

`main.ts` reads the cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each with `run` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=sz67g615&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
