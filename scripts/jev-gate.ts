#!/usr/bin/env node
import { createRealDeps, parseArgs, runGate, writeBaseline } from './jev/gate-run.js';

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const deps = createRealDeps();

try {
  if (args.writeBaseline) {
    const summary = await writeBaseline(args, deps);
    if (!args.quiet) process.stderr.write(`${summary}\n`);
    process.exitCode = 0;
  } else {
    const { report, summary } = await runGate(args, deps);
    if (!args.quiet) process.stderr.write(`${summary}\n`);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) {
      deps.writeTextFile(args.out, json);
    } else {
      process.stdout.write(json);
    }
    process.exitCode = report.exitCode;
  }
} catch (err) {
  // Last-resort backstop for a bug that isn't one of runGate/writeBaseline's own
  // handled failure paths: an infrastructure/tooling failure in this gate must
  // never be worse than "did nothing" — only a genuine configured policy failure
  // (a real gate FAIL in enforcing mode) should ever exit non-zero.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 0;
}
