#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { collectSentry } from './sentry.mjs';
try {
  const { values } = parseArgs({
    options: {
      organization: { type: 'string' },
      project: { type: 'string' },
      environment: { type: 'string' },
      revision: { type: 'string' },
    },
  });
  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.error('Sentry read access is not configured.');
    process.exitCode = 3;
  } else
    console.log(
      JSON.stringify(await collectSentry({ ...values, token: process.env.SENTRY_AUTH_TOKEN })),
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
