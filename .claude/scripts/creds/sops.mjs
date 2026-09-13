#!/usr/bin/env node
// Credentials helper. credentials.json holds REFERENCES (env var names, vault paths, item ids), never values,
// and is sops/age encrypted at rest as defence in depth.
//   encrypt <app_id> <decrypted.json>   validate against the credentials schema, then write encrypted file
//   decrypt <app_id>                    print decrypted JSON to stdout (references only)
//   get <app_id> <key>                  print one entry as JSON
//   recipients <app_id>                 print the age recipients the file is encrypted to
// Key material: SOPS_AGE_KEY_FILE (decrypt) and SOPS_AGE_RECIPIENTS or the "sopsRecipients" field (encrypt).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';

const [cmd, appId, extra] = process.argv.slice(2);
const usage = () => { console.error('usage: sops.mjs encrypt <app_id> <decrypted.json> | decrypt <app_id> | get <app_id> <key> | recipients <app_id>'); process.exit(1); };
if (!cmd || !appId) usage();
const target = `applications/${appId}/credentials.json`;

function sops(args, input) {
  const res = spawnSync('sops', args, { encoding: 'utf8', input, env: process.env });
  if (res.status !== 0) { console.error(`sops failed: ${res.stderr.trim()}`); process.exit(res.status || 1); }
  return res.stdout;
}

function decrypt() {
  if (!existsSync(target)) { console.error(`${target} does not exist`); process.exit(1); }
  return JSON.parse(sops(['--decrypt', '--input-type', 'json', '--output-type', 'json', target]));
}

switch (cmd) {
  case 'encrypt': {
    if (!extra) usage();
    const doc = JSON.parse(readFileSync(extra, 'utf8'));
    const { ajv } = buildAjv();
    const validate = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/application/credentials.schema.json');
    if (!validate(doc)) { console.error(`decrypted document invalid:\n${formatErrors(validate.errors)}`); process.exit(2); }
    if (doc.appId !== appId) { console.error(`appId ${doc.appId} != ${appId}`); process.exit(2); }
    const recipients = process.env.SOPS_AGE_RECIPIENTS || (doc.sopsRecipients || []).join(',');
    if (!recipients) { console.error('no age recipients: set SOPS_AGE_RECIPIENTS or sopsRecipients[] in the document'); process.exit(2); }
    const out = sops(['--encrypt', '--age', recipients, '--input-type', 'json', '--output-type', 'json', '/dev/stdin'], JSON.stringify(doc, null, 2));
    writeFileSync(target, out.endsWith('\n') ? out : out + '\n');
    console.log(`${target} written (encrypted to ${recipients.split(',').length} recipient(s))`);
    break;
  }
  case 'decrypt':
    process.stdout.write(JSON.stringify(decrypt(), null, 2) + '\n');
    break;
  case 'get': {
    if (!extra) usage();
    const entry = (decrypt().entries || []).find((e) => e.key === extra);
    if (!entry) { console.error(`no entry with key ${extra}`); process.exit(2); }
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    break;
  }
  case 'recipients': {
    const doc = JSON.parse(readFileSync(target, 'utf8'));
    for (const r of (doc.sops && doc.sops.age) || []) console.log(r.recipient);
    break;
  }
  default: usage();
}
