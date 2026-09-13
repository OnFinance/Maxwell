#!/usr/bin/env node
// Structural checks on harness assets beyond schema validation: skill dir/name agreement, uniqueness of
// skill/agent/command names across both harness trees, and no command/workflow name collisions.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import matter from 'gray-matter';

const problems = [];
const listMd = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`) : []);
const listSkills = (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(`${dir}/${d}/SKILL.md`)).map((d) => ({ dir: d, file: `${dir}/${d}/SKILL.md` })) : []);
const fm = (file) => { try { return matter(readFileSync(file, 'utf8')).data; } catch (e) { problems.push(`${file}: ${e.message}`); return {}; } };

// Skills: name must equal directory; unique across .claude/skills and .agents/skills (OpenCode reads both).
const skillNames = new Map();
for (const root of ['.claude/skills', '.agents/skills']) {
  for (const s of listSkills(root)) {
    const data = fm(s.file);
    if (data.name !== s.dir) problems.push(`${s.file}: frontmatter name '${data.name}' must equal directory '${s.dir}'`);
    if (skillNames.has(data.name)) problems.push(`${s.file}: skill name '${data.name}' duplicates ${skillNames.get(data.name)} (OpenCode requires unique skill names)`);
    skillNames.set(data.name, s.file);
    const body = readFileSync(s.file, 'utf8');
    if (body.split('\n').length > 500) problems.push(`${s.file}: SKILL.md exceeds 500 lines (agentskills.io guidance)`);
  }
}

// Agents: unique names; file name must equal frontmatter name.
for (const root of ['.claude/agents', '.agents/agents']) {
  const seen = new Set();
  for (const file of listMd(root)) {
    const data = fm(file);
    const base = file.split('/').pop().replace(/\.md$/, '');
    if (root === '.claude/agents' && data.name !== base) problems.push(`${file}: name '${data.name}' must equal file name '${base}'`);
    if (seen.has(base)) problems.push(`${file}: duplicate agent '${base}'`);
    seen.add(base);
  }
}

// Commands must not collide with workflow names (both are invoked as /<name>).
const workflows = new Set(existsSync('.claude/workflows') ? readdirSync('.claude/workflows').filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')) : []);
for (const root of ['.claude/commands', '.agents/commands']) {
  for (const file of listMd(root)) {
    const base = file.split('/').pop().replace(/\.md$/, '');
    if (workflows.has(base)) problems.push(`${file}: command '${base}' collides with workflow .claude/workflows/${base}.js`);
    if (skillNames.has(base)) problems.push(`${file}: command '${base}' collides with skill '${base}'`);
  }
}

if (problems.length) {
  console.error(`validate:frontmatter FAILED (${problems.length})`);
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log(`validate:frontmatter OK (${skillNames.size} skills)`);
