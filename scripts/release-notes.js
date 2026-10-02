#!/usr/bin/env node
// Writes release-notes.md (the current version's CHANGELOG section) so electron-builder embeds it in latest.yml
// and the GitHub release workflow can use it as the release body.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const version = process.argv[2] || require(path.join(root, 'package.json')).version;
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const m = new RegExp(`^## ${esc}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
const body = m && m[1].trim() ? m[1].trim() : `UniVMS ${version}`;
fs.writeFileSync(path.join(root, 'release-notes.md'), body + '\n');
console.log(`[release-notes] ${version}: ${body.split('\n').length} line(s) -> release-notes.md`);
