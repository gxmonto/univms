#!/usr/bin/env node
/*
 * Version bump following the project convention (see CLAUDE.md / README):
 *   major change -> second number  (1.2.3 -> 1.3.0)   npm run release:major
 *   minor change -> third number   (1.2.3 -> 1.2.4)   npm run release:minor
 * The first number is reserved for a full product generation and is changed by hand.
 *
 * What it does: checks for a clean tree, updates package.json + package-lock.json,
 * promotes the "Unreleased" section of CHANGELOG.md to the new version, commits
 * "Release vX.Y.Z", tags vX.Y.Z and (with --push) pushes commit + tag, which
 * triggers the GitHub Actions release build.
 *
 * Usage: node scripts/bump.js major|minor [--push] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const kind = process.argv[2];
const push = process.argv.includes('--push');
const dry = process.argv.includes('--dry-run');
if (!['major', 'minor'].includes(kind)) {
  console.error('usage: node scripts/bump.js major|minor [--push] [--dry-run]\n  major = second number (1.2.3 -> 1.3.0), minor = third number (1.2.3 -> 1.2.4)');
  process.exit(2);
}
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [a, b, c] = pkg.version.split('.').map(Number);
const next = kind === 'major' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;

if (!dry) {
  const dirty = sh('git status --porcelain');
  if (dirty) { console.error('Working tree is not clean. Commit or stash first:\n' + dirty); process.exit(1); }
}

// CHANGELOG: move "## Unreleased" content under the new version
const clPath = path.join(root, 'CHANGELOG.md');
let changelog = (fs.existsSync(clPath) ? fs.readFileSync(clPath, 'utf8') : '# Changelog\n\n## Unreleased\n').replace(/\r\n/g, '\n'); // CRLF-safe
const m = /^## Unreleased[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
const body = m && m[1].trim() ? m[1].trim() : '- Maintenance release.';
const date = new Date().toISOString().slice(0, 10);
const entry = `## ${next} - ${date}\n\n${body}\n`;
changelog = m
  ? changelog.replace(m[0], `## Unreleased\n\n${entry}`)
  : changelog.replace(/# Changelog\s*\n/, `# Changelog\n\n## Unreleased\n\n${entry}`);

console.log(`${pkg.version} -> ${next} (${kind} change: ${kind === 'major' ? 'second' : 'third'} number)`);
console.log('Changelog entry:\n' + body.split('\n').map((l) => '  ' + l).join('\n'));
if (dry) process.exit(0);

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
fs.writeFileSync(clPath, changelog);
fs.writeFileSync(path.join(root, 'release-notes.md'), body + '\n');

sh('git add package.json package-lock.json CHANGELOG.md release-notes.md');
sh(`git commit -q -m "Release v${next}"`);
sh(`git tag -a v${next} -m "UniVMS ${next}"`);
console.log(`Committed and tagged v${next}`);
if (push) {
  sh('git push --follow-tags');
  console.log('Pushed. GitHub Actions will build the installers and attach them to the release.');
} else {
  console.log('Run `git push --follow-tags` to publish (this triggers the release build).');
}
