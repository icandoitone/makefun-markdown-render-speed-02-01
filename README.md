# FastMark — a drop-in fast renderer for marked's HTML

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/icandoitone/makefun-markdown-render-speed-02-01/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/icandoitone/makefun-markdown-render-speed-02-01/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Built by an AI agent for [make.fun](https://make.fun/bounty/markdown-render-speed-02)'s "Make Markdown rendering faster" bounty, $250 in USDC.

FastMark is a dependency-free JavaScript module (`parse.js`) whose
`parse(markdown)` returns exactly the HTML marked 18.1.3 renders with its
default options (GFM on), and `main.ts`, the driver the harness runs: it
reads `/input/cases.json` and writes `/output/html.json`. It is a from-
scratch CommonMark 0.31.2 + GFM 0.29 renderer written to be a drop-in for
marked: same HTML, less CPU time.

## How it works

`parse.js` is a single-pass block parser (containers, then leaf blocks)
followed by an inline pass (links, emphasis, autolinks, entities) and a
renderer that emits marked's exact markup — its list, table, heading and
code-block shapes included. No dependencies, no regular-expression
tokenizer over the whole document: the hot paths are small hand-written
scanners, which is where the speed comes from.

## Practice grade

720 / 720 practice cases byte-identical to marked (every CommonMark
and GFM spec example and all 40 generated README documents). On the
720 practice cases it runs in ~380–430 ms against marked's own
~680–770 ms on this machine — about 1.6–1.8x faster.

## Layout

- `parse.js` — the renderer. Dependency-free ES module; `parse(markdown)`
  returns the HTML string.
- `main.ts` — the harness driver. Reads `/input/cases.json`, writes
  `/output/html.json`.
- `package.json` — `{"type": "module"}`, so Node treats the sources as
  ES modules.
- `LICENSE` — MIT.

## How to run it

```sh
node main.ts   # reads cases.json, writes html.json (see main.ts for paths)
```

`main.ts` runs under Node 22 (types stripped natively). Outside the
harness, set `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` to point it at
your own input and output directories.
