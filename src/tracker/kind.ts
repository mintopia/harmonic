import type { ZodType } from 'zod';
import type { FeatureIndex } from './local-markdown.js';
import type { TrackerAdapter, TrackerRef } from './adapter.js';

/** What a kind can do beyond reading; consumers gate on this instead of probing the adapter. */
export interface TrackerCapabilities {
  close: boolean;
  reopen: boolean;
  claim: boolean;
  transition: boolean;
  /** Where the kind finds Epics (e.g. `epic-label`, `spec`); empty when it has none. */
  epicSources: readonly string[];
}

/** An injected HTTP client for kinds that talk to a REST API directly. */
export type TrackerHttp = (url: string, init?: RequestInit) => Promise<Response>;

/** Runs a tracker CLI (`gh`, `glab`) in the repo and returns stdout. Injectable for tests. */
export type CliRunner = (args: string[], cwd: string) => Promise<string>;

export interface TrackerCreateContext<S> {
  settings: S;
  secrets: Readonly<Record<string, string>>;
  repoRoot: string;
  http: TrackerHttp;
  /** Overrides the kind's default CLI runner (CLI-backed kinds only). */
  run?: CliRunner;
  featureIndex?: FeatureIndex;
}

/** One tracker, registered once: the kinds list is the only enumeration of trackers. */
export interface TrackerKind<S = unknown> {
  id: string;
  label: string;
  settings: ZodType<S>;
  /** Names of the Secrets this kind reads from `create`'s `secrets`. */
  secretNames: readonly string[];
  capabilities: TrackerCapabilities;
  /** Raw settings read from the repo's `docs/agents/issue-tracker.md` declaration; parsed against {@link settings}. */
  fromDeclaration?(doc: string, repoRoot: string): Promise<unknown> | unknown;
  /** How a ref is shown to people (`#185`, `PROJ-185`); the only place a ref is formatted. */
  formatRef(ref: TrackerRef): string;
  create(ctx: TrackerCreateContext<S>): TrackerAdapter;
}
