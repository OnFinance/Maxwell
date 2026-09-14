#!/usr/bin/env node
// Enforces the sanctioned workspace layout: no extra root entries, no extra harness dirs, no unsanctioned
// files, and required files present for every company and application. Exit 2 on violations.
import { existsSync, readdirSync } from 'node:fs';
import { loadLayout, matchRule, walkWorkspace } from './lib/layout.mjs';

const layout = loadLayout();
const problems = [];

const rootAllowed = new Set(layout.rootEntries);
for (const entry of readdirSync('.')) {
  if (!rootAllowed.has(entry)) problems.push(`root entry '${entry}' is not allowed. Allowed: ${[...rootAllowed].filter((e) => !['node_modules', '.git'].includes(e)).join(', ')}`);
}

for (const [dir, allowed] of Object.entries(layout.harnessDirs)) {
  if (!existsSync(dir)) { problems.push(`missing harness directory ${dir}`); continue; }
  const allow = new Set(allowed);
  // worktrees/ is where Claude Code puts isolated agent worktrees: transient and gitignored.
  for (const entry of readdirSync(dir)) if (!allow.has(entry) && !(dir === '.claude' && entry === 'worktrees')) problems.push(`${dir}/${entry} is not allowed. Allowed: ${allowed.join(', ')}`);
  for (const required of allowed) if (!existsSync(`${dir}/${required}`)) problems.push(`${dir}/${required} is required but missing`);
}

for (const entry of walkWorkspace('.')) {
  if (entry.isDir || entry.checkout) continue;
  if (!matchRule(layout, entry.relPath)) problems.push(`unsanctioned file: ${entry.relPath}`);
}

for (const f of layout.requiredFiles) if (!existsSync(f)) problems.push(`required file missing: ${f}`);

if (existsSync('company-profile')) {
  for (const company of readdirSync('company-profile')) {
    if (company === '.gitkeep') continue;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(company)) problems.push(`company-profile/${company}: company_id must be a slug`);
    for (const f of layout.requiredPerCompany) if (!existsSync(`company-profile/${company}/${f}`)) problems.push(`company-profile/${company}/${f} is required`);
  }
}
if (existsSync('applications')) {
  for (const app of readdirSync('applications')) {
    if (app === '.gitkeep') continue;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(app)) problems.push(`applications/${app}: app_id must be a slug`);
    for (const f of layout.requiredPerApplication) if (!existsSync(`applications/${app}/${f}`)) problems.push(`applications/${app}/${f} is required`);
  }
}

if (problems.length) {
  console.error(`validate:layout FAILED (${problems.length})`);
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log('validate:layout OK');
