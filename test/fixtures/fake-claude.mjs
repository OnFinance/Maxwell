#!/usr/bin/env node
// Stand-in for the `claude` CLI used by tests. Reviewer runs flag the first low-level call (or the first
// `AccountInfo` line on Solana); refuter runs confirm every candidate. FAKE_CLAUDE_MODE=refute-all refutes all,
// FAKE_CLAUDE_MODE=fail exits non-zero.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0 (fake)');
  process.exit(0);
}
const mode = process.env.FAKE_CLAUDE_MODE || '';
if (mode === 'fail') {
  console.error('simulated failure');
  process.exit(1);
}
const system = args[args.indexOf('--system-prompt') + 1] || '';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let output;
  if (system.startsWith('# Adversarial refuter')) {
    const candidates = JSON.parse(/## Candidates\n([\s\S]*?)\n\n## Source/.exec(input)[1]);
    output = {
      verdicts: candidates.map((c) => ({
        id: c.id,
        verdict: mode === 'refute-all' ? 'refuted' : 'confirmed',
        confidence: 0.9,
        severity: c.severity,
        reason: 'fake verdict',
      })),
    };
  } else {
    const findings = [];
    let file;
    for (const line of input.split('\n')) {
      const header = /^===== FILE: (.+) \(\d+ lines\) =====$/.exec(line);
      if (header) file = header[1];
      const m = /^\s*(\d+)\| (.*)$/.exec(line);
      if (file && m && /\.call\{|is_signer|authority = next_account_info/.test(m[2]) && !findings.length) {
        findings.push({
          file, startLine: Number(m[1]), endLine: Number(m[1]),
          category: system.includes('Solana') ? 'signer_authorization' : 'reentrancy',
          severity: 'high', title: 'fake finding', description: 'fake description',
          exploitScenario: '1. attack', remediation: 'fix it', confidence: 0.9,
        });
      }
    }
    // A second, low-severity finding that the pipeline must drop before refutation.
    if (findings.length) findings.push({ ...findings[0], category: 'other', severity: 'low', title: 'nit' });
    output = { findings };
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, structured_output: output }));
});
