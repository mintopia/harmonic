#!/usr/bin/env node
'use strict';

// Dependency-free CommonJS, no imports from this package's own dist: it must run before that
// dist even exists. Rescues 2.18.0/2.18.1 systemd self-upgrades, which ran
// `npm i --prefix versions/<v> @mintopia/harmonic@<v>` and nested the install at
// `versions/<v>/node_modules/@mintopia/harmonic/dist` instead of `versions/<v>/dist`, breaking the
// old verify step and the next restart. Symlinking `versions/<v>/dist` to the nested `dist` lets the
// old verify's `current/dist/../package.json` read resolve to the real (versioned) manifest, and lets
// systemd's `node current/dist/cli.js` resolve through the symlink chain to the installed code.
// Always exits 0 and never throws: a broken rescue must not fail an install.

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const pkgRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const segments = pkgRoot.split(path.sep);
  const len = segments.length;
  if (len < 5) return;
  if (segments[len - 1] !== 'harmonic' || segments[len - 2] !== '@mintopia' || segments[len - 3] !== 'node_modules') return;
  if (segments[len - 5] !== 'versions') return;
  const stagedVersion = segments[len - 4];

  const ownVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  if (stagedVersion !== ownVersion) return;

  const versionDir = segments.slice(0, len - 3).join(path.sep);
  const distLink = path.join(versionDir, 'dist');
  if (fs.existsSync(distLink)) return;

  const target = path.join('node_modules', '@mintopia', 'harmonic', 'dist');
  fs.symlinkSync(target, distLink, 'dir');
  console.log(`harmonic postinstall-rescue: linked ${distLink} -> ${target}`);
}

try {
  main();
} catch {
}
