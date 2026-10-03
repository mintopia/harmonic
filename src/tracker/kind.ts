import type { ZodType } from 'zod';
import type { FeatureIndex } from './local-markdown.js';
import type { TrackerAdapter } from './adapter.js';
import type { TrackerRef } from './ref.js';
import type { TriageLabels } from './triage-labels.js';

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
  /** The Workspace's resolved Triage Labels, for kinds that filter their scan by label. */
  triageLabels?: TriageLabels;
}

/** The repo's `origin` remote URL, read at most once per resolution; null when there is none. */
export type OriginRemote = () => Promise<string | null>;

/** One tracker, registered once: the kinds list is the only enumeration of trackers. */
export interface TrackerKind<S = unknown> {
  id: string;
  label: string;
  settings: ZodType<S>;
  /** The default Secret names this kind reads from `create`'s `secrets`; the settings UI lists these. */
  secretNames: readonly string[];
  /** The Secret names these settings read, when they can differ from {@link secretNames} (a configured token name). */
  secretsFor?(settings: S): readonly string[];
  capabilities: TrackerCapabilities;
  /** Raw settings read from the repo's `docs/agents/issue-tracker.md` declaration; parsed against {@link settings}. */
  fromDeclaration?(doc: string, repoRoot: string, origin: OriginRemote): Promise<unknown> | unknown;
  create(ctx: TrackerCreateContext<S>): TrackerAdapter;
  /** How this tracker writes one of its refs for a person (`#185`, `PROJ-185`); the only place a ref is formatted. */
  formatRef(ref: TrackerRef): string;
}
