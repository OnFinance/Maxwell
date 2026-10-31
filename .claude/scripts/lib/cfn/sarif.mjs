// cfn-verify's export: one SARIF 2.1.0 log, a run per tool (cfn-lint, cfn-guard, the emulator, live AWS), each result
// with the checkout-relative file, its line and the template resource it falls in, so a finding cites tool, rule id,
// file and line exactly as written here. The log's properties["maxwell:cfn-verify"] says what ran and what did not.
import { readTemplate } from './templates.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SEVERITY = { high: { level: 'error', score: '7.5' }, medium: { level: 'warning', score: '5.0' }, low: { level: 'note', score: '3.0' } };

const loc = (path, startLine, extra = {}) => [{ physicalLocation: { artifactLocation: { uri: path, uriBaseId: 'CHECKOUT' }, region: { startLine: Math.max(1, Number(startLine) || 1), ...extra } } }];

/** The resource whose block holds `line` (the last one starting at or before it). */
function resourceAt(resources, line) {
  let best = null;
  for (const r of resources) if (r.line && r.line <= line && (!best || r.line > best.line)) best = r;
  return best;
}

export function toSarif({ report, lint, guard, emulated, live, tools, ruleSets, pins, checkout }) {
  const parsed = new Map();
  const tplOf = (path) => { if (!parsed.has(path)) { try { parsed.set(path, readTemplate(readFileSync(join(checkout, path), 'utf8'))); } catch { parsed.set(path, { resources: [] }); } } return parsed.get(path); };
  const lineOf = (path, logicalId) => ((tplOf(path).resources.find((r) => r.logicalId === logicalId) || {}).line) || 1;
  const runs = [];

  if (tools['cfn-lint']) {
    runs.push({ tool: { driver: { name: 'cfn-lint', version: tools['cfn-lint'].version, informationUri: 'https://github.com/aws-cloudformation/cfn-lint' } },
      results: lint.map((r) => {
        const region = (r.locations && r.locations[0] && r.locations[0].physicalLocation.region) || {};
        const res = resourceAt(tplOf(r.path).resources, region.startLine || 1);
        const level = r.level || ({ E: 'error', W: 'warning', I: 'note' }[String(r.ruleId || '')[0]] || 'warning');
        return { ruleId: r.ruleId, level, message: { text: String((r.message && r.message.text) || '').slice(0, 2000) }, locations: loc(r.path, region.startLine, { ...(region.startColumn ? { startColumn: region.startColumn } : {}), ...(region.endLine ? { endLine: region.endLine } : {}) }),
          properties: { tool: 'cfn-lint', toolVersion: tools['cfn-lint'].version, ...(res ? { resource: res.logicalId, resourceType: res.type } : {}) } };
      }) });
  }

  if (tools['cfn-guard'] && ruleSets.length) {
    // cfn-guard puts every result at line 1 and the real place in its message ("[L:316,C:8]"): the line is read from
    // there; the same rule at the same place from several rule sets is one result listing them.
    const seen = new Map();
    for (const r of guard) {
      const text = String((r.message && r.message.text) || '');
      const m = /\[L:(\d+),C:(\d+)\]/.exec(text);
      const line = m ? Number(m[1]) : 1;
      const resId = (/\/Resources\/([A-Za-z0-9]+)/.exec(text) || [])[1];
      const key = `${r.ruleId}|${r.path}|${line}`;
      if (seen.has(key)) { const prev = seen.get(key); if (!prev.properties.ruleSets.includes(r.ruleSet)) prev.properties.ruleSets.push(r.ruleSet); continue; }
      const res = resId ? tplOf(r.path).resources.find((x) => x.logicalId === resId) : resourceAt(tplOf(r.path).resources, line);
      const controls = (/Controls:\s*([^\n]+)/.exec(text) || [])[1];
      seen.set(key, { ruleId: r.ruleId, level: r.level || 'error', message: { text: text.replace(/\s+\n/g, '\n').trim().slice(0, 2000) }, locations: loc(r.path, line, m ? { startColumn: Number(m[2]) } : {}),
        properties: { tool: 'cfn-guard', toolVersion: tools['cfn-guard'].version, ruleSets: [r.ruleSet], ...(controls ? { controls: controls.trim() } : {}), ...(res ? { resource: res.logicalId, resourceType: res.type } : {}) } });
    }
    runs.push({ tool: { driver: { name: 'cfn-guard', version: tools['cfn-guard'].version, informationUri: 'https://github.com/aws-cloudformation/cloudformation-guard' } },
      properties: { ruleSets: ruleSets.map((s) => ({ name: s.name, sha256: s.sha256, registry: `aws-guard-rules-registry ${pins.guardRules.version}` })) }, results: [...seen.values()] });
  }

  if (report.emulator && report.emulator.name) {
    const name = `${report.emulator.name} ${report.emulator.version}`;
    const results = [];
    for (const e of emulated) {
      const r = e.result;
      for (const f of r.failed) results.push({ ruleId: 'emulator-create-failed', level: 'error', message: { text: `${f.logicalId} (${f.type}) failed to create in ${name}: ${f.status}${f.reason ? `: ${f.reason}` : ''}` },
        locations: loc(e.path, lineOf(e.path, f.logicalId)), properties: { tool: 'maxwell-cfn-emulator', emulator: name, resource: f.logicalId, resourceType: f.type, stackStatus: r.status } });
      for (const n of r.notVerified) results.push({ ruleId: 'emulator-not-verified', kind: 'review', level: 'none', message: { text: `${n.logicalId} (${n.type || 'unknown type'}) was not verified in ${name}: ${n.reason}` },
        locations: loc(e.path, lineOf(e.path, n.logicalId)), properties: { tool: 'maxwell-cfn-emulator', emulator: name, resource: n.logicalId, resourceType: n.type, verification: 'not-verified' } });
      for (const p of r.posture) {
        const base = { locations: loc(e.path, lineOf(e.path, p.logicalId)), properties: { tool: 'maxwell-cfn-emulator', emulator: name, resource: p.logicalId, resourceType: p.type, check: p.check, verification: p.status } };
        const msg = `${p.logicalId} (${p.type}) as created in ${name}${r.withoutTags ? ' (without its Tags: the emulator failed on them)' : ''}: ${p.message}`;
        if (p.status === 'finding') { const s = SEVERITY[p.severity] || SEVERITY.medium; results.push({ ruleId: `emulated-${p.check}`, level: s.level, message: { text: msg }, ...base, properties: { ...base.properties, 'security-severity': s.score } }); }
        else if (p.status === 'pass') results.push({ ruleId: `emulated-${p.check}`, kind: 'pass', level: 'none', message: { text: msg }, ...base });
        else results.push({ ruleId: `emulated-${p.check}`, kind: 'review', level: 'none', message: { text: `${msg} (not verified)` }, ...base });
      }
    }
    runs.push({ tool: { driver: { name: 'maxwell-cfn-emulator', version: report.emulator.version, informationUri: report.emulator.name === 'moto' ? 'https://github.com/getmoto/moto' : 'https://www.localstack.cloud' } },
      properties: { emulator: report.emulator.name, version: report.emulator.version, endpoint: report.emulator.endpoint, stacks: report.emulator.stacks }, results });
  }

  if (report.liveAws && report.liveAws.ran) {
    const results = [];
    for (const l of live) {
      if (l.validate && l.validate.status === 'invalid') results.push({ ruleId: 'aws-validate-template', level: 'error', message: { text: `CloudFormation rejected the template: ${l.validate.reason}` }, locations: loc(l.path, 1), properties: { tool: 'aws-cloudformation' } });
      if (l.validate && l.validate.status === 'valid') results.push({ ruleId: 'aws-validate-template', kind: 'pass', level: 'none', message: { text: 'CloudFormation validated the template (validate-template)' }, locations: loc(l.path, 1), properties: { tool: 'aws-cloudformation', capabilities: l.validate.capabilities } });
      if (l.drift && l.drift.status === 'DRIFTED') for (const d of l.drift.resources || [])
        results.push({ ruleId: 'aws-stack-drift', level: 'warning', message: { text: `${d.logicalId} (${d.type}) in the deployed stack is ${d.status} against its template: ${d.properties.join(', ') || 'no property detail'}` }, locations: loc(l.path, lineOf(l.path, d.logicalId)), properties: { tool: 'aws-cloudformation', resource: d.logicalId, resourceType: d.type } });
    }
    runs.push({ tool: { driver: { name: 'aws-cloudformation', version: report.emulator && report.emulator.aws ? report.emulator.aws : 'aws-cli', informationUri: 'https://docs.aws.amazon.com/cli/latest/reference/cloudformation/' } },
      properties: { account: report.liveAws.account, region: report.liveAws.region, credential: report.liveAws.credential, templates: report.liveAws.templates }, results });
  }
  return { version: '2.1.0', $schema: SCHEMA, runs, properties: { 'maxwell:cfn-verify': report } };
}
