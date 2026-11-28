// SARIF 2.1.0 writer.
import crypto from 'node:crypto';
import { sarifLevel, TAXONOMY } from './taxonomy.mjs';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const TOOL_NAME = 'maxwell-web3';

function fingerprint(f) {
  return crypto.createHash('sha256').update(`${f.file}\0${f.category}\0${f.startLine}\0${f.title}`).digest('hex');
}

/**
 * @param {object} input
 * @param {'ethereum'|'solana'} input.chain
 * @param {Array} input.findings normalised findings
 * @param {number} input.costUsd total LLM spend
 * @param {object} [input.properties] extra run properties
 * @param {Array<{level: string, message: string}>} [input.notifications]
 */
export function buildSarif({ chain, findings, costUsd, version = '0.1.0', properties = {}, notifications = [] }) {
  const rules = TAXONOMY[chain].map((id) => ({
    id,
    name: id,
    shortDescription: { text: `${chain} ${id.replace(/_/g, ' ')}` },
    properties: { category: id, chain },
  }));
  const results = findings.map((f) => ({
    ruleId: f.category,
    ruleIndex: TAXONOMY[chain].indexOf(f.category),
    level: sarifLevel(f.severity),
    message: { text: f.description && f.description !== f.title ? `${f.title}: ${f.description}` : f.title },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file, uriBaseId: 'TARGET' },
          region: { startLine: f.startLine, endLine: f.endLine },
        },
      },
    ],
    partialFingerprints: { 'maxwellFinding/v1': fingerprint(f) },
    properties: {
      category: f.category,
      severity: f.severity,
      exploitScenario: f.exploitScenario,
      remediation: f.remediation,
      confidence: f.confidence,
      title: f.title,
      ...(f.refutation ? { refutation: f.refutation } : {}),
    },
  }));
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version,
            informationUri: 'https://github.com/OnFinance/Maxwell/tree/web3',
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: notifications.map((n) => ({ level: n.level, message: { text: n.message } })),
          },
        ],
        results,
        properties: { chain, costUsd: Math.round(costUsd * 1e6) / 1e6, ...properties },
      },
    ],
  };
}
