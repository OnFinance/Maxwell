#!/usr/bin/env node
// Quick validation script for ARTEX integration before committing

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const errors = [];
const warnings = [];

function check(condition, message, isWarning = false) {
  if (!condition) {
    (isWarning ? warnings : errors).push(message);
  }
}

console.log('🔍 Validating ARTEX integration...\n');

// 1. Check all required files exist
console.log('1. Checking required files...');
const requiredFiles = [
  '.claude/schemas/v1/artex/attack-path.schema.json',
  '.claude/schemas/v1/artex/task.schema.json',
  '.claude/agents/redteam-orchestrator.md',
  '.claude/agents/artex-reconciler.md',
  '.claude/workflows/runtime-probe-redteam.js',
  '.claude/scripts/artex/run.mjs',
  '.claude/scripts/artex/export-graphs.mjs',
  'ARTEX-INTEGRATION.md',
  'PR_SUMMARY.md'
];

for (const file of requiredFiles) {
  check(existsSync(file), `Missing required file: ${file}`);
}

// 2. Check schema files are valid JSON
console.log('2. Validating schema JSON...');
const schemaFiles = [
  '.claude/schemas/v1/artex/attack-path.schema.json',
  '.claude/schemas/v1/artex/task.schema.json'
];

for (const file of schemaFiles) {
  if (existsSync(file)) {
    try {
      const content = readFileSync(file, 'utf8');
      const json = JSON.parse(content);
      check(json.$schema === 'https://json-schema.org/draft/2020-12/schema', 
            `${file}: Must use draft 2020-12`);
      check(json.schemaVersion === '1' || json.properties?.schemaVersion?.const === '1',
            `${file}: Must have schemaVersion`);
      check(json.examples && json.examples.length > 0,
            `${file}: Should have examples`, true);
    } catch (err) {
      errors.push(`${file}: Invalid JSON - ${err.message}`);
    }
  }
}

// 3. Check layout.json includes artex
console.log('3. Checking layout.json...');
if (existsSync('.claude/schemas/layout.json')) {
  try {
    const layout = JSON.parse(readFileSync('.claude/schemas/layout.json', 'utf8'));
    check(layout.rootEntries.includes('artex'), 
          'layout.json: Missing "artex" in rootEntries');
    
    const artexRules = layout.rules.filter(r => r.glob.startsWith('artex/'));
    check(artexRules.length >= 10,
          `layout.json: Expected at least 10 artex/ rules, found ${artexRules.length}`);
  } catch (err) {
    errors.push(`layout.json: Invalid JSON - ${err.message}`);
  }
}

// 4. Check workflow has correct structure
console.log('4. Validating workflow structure...');
if (existsSync('.claude/workflows/runtime-probe-redteam.js')) {
  const workflow = readFileSync('.claude/workflows/runtime-probe-redteam.js', 'utf8');
  check(workflow.includes('export const meta'), 
        'runtime-probe-redteam.js: Missing export const meta');
  check(workflow.includes('name: \'runtime-probe-redteam\''),
        'runtime-probe-redteam.js: Missing workflow name in meta');
  check(workflow.includes('phases:'),
        'runtime-probe-redteam.js: Missing phases in meta');
  check(workflow.includes('authorization') && workflow.includes('authorizedBy'),
        'runtime-probe-redteam.js: Missing authorization validation');
  check(workflow.includes('ARTEX_VERSION'),
        'runtime-probe-redteam.js: Missing ARTEX_VERSION constant');
}

// 5. Check agents have proper structure
console.log('5. Validating agent structure...');
const agents = [
  '.claude/agents/redteam-orchestrator.md',
  '.claude/agents/artex-reconciler.md'
];

for (const agent of agents) {
  if (existsSync(agent)) {
    const content = readFileSync(agent, 'utf8');
    const lines = content.split('\n');
    check(lines[0].startsWith('# '),
          `${agent}: Must start with # agent-name`);
    check(content.includes('## Your role') || content.includes('## Your inputs'),
          `${agent}: Should have structured sections`, true);
    check(content.length > 1000,
          `${agent}: Agent guide seems too short (< 1000 chars)`, true);
  }
}

// 6. Check for sensitive data
console.log('6. Checking for sensitive data...');
const allFiles = [...requiredFiles, '.claude/schemas/layout.json'];
const sensitivePatterns = [
  /password.*[=:]\s*['"][^'"]{8,}['"]/i,
  /api[-_]?key.*[=:]\s*['"][^'"]{20,}['"]/i,
  /secret.*[=:]\s*['"][^'"]{20,}['"]/i,
  /token.*[=:]\s*['"][^'"]{20,}['"]/i,
  /-----BEGIN (RSA |)PRIVATE KEY-----/,
  /\b[A-Za-z0-9._%+-]+@(?!example\.com|test\.com|localhost)[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/
];

for (const file of allFiles) {
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of sensitivePatterns) {
      if (pattern.test(content)) {
        // Exclude example patterns
        if (!content.includes('example.com') && !content.includes('AKIA...')) {
          warnings.push(`${file}: Possible sensitive data detected (pattern: ${pattern})`);
        }
      }
    }
  }
}

// 7. Check documentation
console.log('7. Validating documentation...');
if (existsSync('ARTEX-INTEGRATION.md')) {
  const doc = readFileSync('ARTEX-INTEGRATION.md', 'utf8');
  check(doc.includes('# ARTEX'),
        'ARTEX-INTEGRATION.md: Missing main heading');
  check(doc.includes('## Prerequisites'),
        'ARTEX-INTEGRATION.md: Missing prerequisites section');
  check(doc.includes('## Safety Mechanisms'),
        'ARTEX-INTEGRATION.md: Missing safety mechanisms section');
  check(doc.includes('reconnaissance-only'),
        'ARTEX-INTEGRATION.md: Missing mode documentation');
  check(doc.length > 10000,
        'ARTEX-INTEGRATION.md: Documentation seems incomplete', true);
}

// 8. Check scripts are executable
console.log('8. Checking script shebangs...');
const scripts = [
  '.claude/scripts/artex/run.mjs',
  '.claude/scripts/artex/export-graphs.mjs',
  '.claude/scripts/artex/validate-integration.mjs'
];

for (const script of scripts) {
  if (existsSync(script)) {
    const content = readFileSync(script, 'utf8');
    check(content.startsWith('#!/usr/bin/env node'),
          `${script}: Missing shebang`);
    check(content.includes('import '),
          `${script}: Should use ES modules`, true);
  }
}

// Results
console.log('\n' + '='.repeat(60));
if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All validation checks passed!');
  console.log('\nReady to commit. Run:');
  console.log('  git add .');
  console.log('  git commit -m "feat: add autonomous ARTEX red-team integration"');
  console.log('  git push -u fork HEAD:feat/artex-autonomous-redteam');
  process.exit(0);
} else {
  if (errors.length > 0) {
    console.log(`❌ ${errors.length} error(s) found:\n`);
    errors.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
  }
  
  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s):\n`);
    warnings.forEach((warn, i) => console.log(`  ${i + 1}. ${warn}`));
  }
  
  if (errors.length > 0) {
    console.log('\n❌ Fix errors before committing.');
    process.exit(1);
  } else {
    console.log('\n⚠️  Warnings found but not blocking. Review before committing.');
    process.exit(0);
  }
}
