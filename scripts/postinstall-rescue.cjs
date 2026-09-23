#!/usr/bin/env node
'use strict';

// Dependency-free CommonJS (must run before this package's own dist exists). Rescues
// 2.18.0/2.18.1 installs that nested the install under node_modules by symlinking
// `versions/<v>/dist` to it, so `current/dist/cli.js` and its package.json still resolve.

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
