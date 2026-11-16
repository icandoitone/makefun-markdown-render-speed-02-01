// Driver for the markdown-render-speed-02 entry: reads the cases the
// harness hands it, renders each one alone with parse() from parse.js,
// and writes the HTML strings back in the cases' order.
//
// The harness runs `node /bot/main.ts` (Node 22, types stripped). It
// puts the cases at /input/cases.json and expects /output/html.json;
// outside a container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in
// for those two directories.
//
// Contract: /input/cases.json is a JSON array of {id, markdown};
// /output/html.json is a JSON array of HTML strings, one per case and
// in the cases' order. parse() must return, for every string, exactly
// the HTML marked 18.1.3 renders with its defaults. The driver does no
// timing, logging or extra work of its own, so it adds no CPU time to
// the heat beyond the parse calls themselves.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(
  readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'),
);

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
