// CloudFormation templates in a checkout: which files are templates, their resources (logical id, type, line) and what
// each resource's block declares, read without evaluating anything (no YAML tags are resolved, no code runs).
// YAML is read by indentation (CloudFormation's block style, short-form tags such as !Ref left as text); JSON is parsed
// and each resource's line is found in the text. Good enough to point a finding at the resource that holds it.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const EXT = /\.(ya?ml|json|template)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.terraform', 'cdk.out', '.venv', 'venv', '__pycache__', 'vendor']);
export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATES = 50;

/** Whether the text is a CloudFormation (or SAM) template. */
export function isTemplate(text) {
  if (/^\s*["']?AWSTemplateFormatVersion["']?\s*:/m.test(text)) return true;
  return /^\s*["']?Resources["']?\s*:/m.test(text) && /["']?Type["']?\s*:\s*["']?(AWS|Custom|Alexa)::[A-Za-z0-9]+(::[A-Za-z0-9]+)?/.test(text);
}

/** Template files under `root` (relative POSIX paths, sorted), plain files only, never through a link. */
export function findTemplates(root, { max = MAX_TEMPLATES } = {}) {
  const out = [];
  const skipped = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (!e.isFile() || !EXT.test(e.name)) continue;
      const rel = relative(root, p).split(sep).join('/');
      const st = lstatSync(p);
      if (st.size > MAX_TEMPLATE_BYTES) { skipped.push({ path: rel, reason: `larger than ${MAX_TEMPLATE_BYTES} bytes` }); continue; }
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      if (!isTemplate(text)) continue;
      if (out.length >= max) { skipped.push({ path: rel, reason: `more than ${max} templates in the checkout` }); continue; }
      out.push(rel);
    }
  };
  walk(root);
  return { templates: out, skipped };
}

const indentOf = (line) => line.length - line.trimStart().length;
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The YAML top-level section `name`'s lines: [start index (the key's line), end index (exclusive)]. */
function yamlSection(lines, name) {
  const re = new RegExp(`^["']?${name}["']?\\s*:\\s*$`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || lines[end].trimStart().startsWith('#') || indentOf(lines[end]) > 0)) end += 1;
  return [start, end];
}

/** Children of a YAML mapping section: [{ key, line (1-based), start, end }]. */
function yamlChildren(lines, [start, end]) {
  const kids = [];
  let indent = null;
  for (let i = start + 1; i < end; i += 1) {
    const l = lines[i];
    if (!l.trim() || l.trimStart().startsWith('#')) continue;
    const ind = indentOf(l);
    if (indent === null) indent = ind;
    if (ind !== indent) continue;
    const m = /^\s*["']?([A-Za-z0-9]+)["']?\s*:/.exec(l);
    if (m) kids.push({ key: m[1], line: i + 1, start: i });
  }
  for (let k = 0; k < kids.length; k += 1) {
    let e = k + 1 < kids.length ? kids[k + 1].start : end;
    while (e > kids[k].start + 1 && !lines[e - 1].trim()) e -= 1;
    kids[k].end = e;
  }
  return kids;
}

/**
 * The template's resources and parameters. `resources`: { logicalId, type, line, text } (text: the resource's own
 * lines); `parameters`: { name, type, default, allowedValues, allowedPattern, minValue, line }; `transform` when the
 * template declares one (SAM, macros).
 */
export function readTemplate(text) {
  const t = text.replace(/^﻿/, '');
  if (t.trimStart().startsWith('{')) return readJson(t);
  const lines = t.split(/\r?\n/);
  const out = { format: 'yaml', resources: [], parameters: [], transform: null };
  const tr = lines.find((l) => /^["']?Transform["']?\s*:/.test(l));
  if (tr) out.transform = unquote(tr.split(':').slice(1).join(':')) || 'declared';
  const res = yamlSection(lines, 'Resources');
  if (res) for (const k of yamlChildren(lines, res)) {
    const block = lines.slice(k.start, k.end);
    const typeLine = block.find((l) => /^\s*["']?Type["']?\s*:/.test(l) && indentOf(l) > indentOf(lines[k.start]));
    out.resources.push({ logicalId: k.key, type: typeLine ? unquote(typeLine.split(':').slice(1).join(':')) : null, line: k.line, text: block.join('\n') });
  }
  const par = yamlSection(lines, 'Parameters');
  if (par) for (const k of yamlChildren(lines, par)) {
    const block = lines.slice(k.start + 1, k.end);
    const field = (name) => { const l = block.find((x) => new RegExp(`^\\s*["']?${name}["']?\\s*:`).test(x)); return l === undefined ? undefined : unquote(l.split(':').slice(1).join(':')); };
    let allowed = field('AllowedValues');
    if (allowed !== undefined) {
      if (/^\[.*\]$/.test(allowed)) allowed = allowed.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else { const i = block.findIndex((x) => /^\s*AllowedValues\s*:/.test(x)); allowed = []; for (let j = i + 1; j < block.length && /^\s*-\s/.test(block[j]); j += 1) allowed.push(unquote(block[j].replace(/^\s*-\s*/, ''))); }
    }
    out.parameters.push({ name: k.key, type: field('Type') ?? 'String', default: field('Default'), allowedValues: allowed, allowedPattern: field('AllowedPattern'), minValue: field('MinValue'), line: k.line });
  }
  return out;
}

function readJson(t) {
  const out = { format: 'json', resources: [], parameters: [], transform: null };
  let doc;
  try { doc = JSON.parse(t); } catch { return out; }
  const lineOf = (key, from = 0) => { const i = t.indexOf(`"${key}"`, from); return i < 0 ? null : t.slice(0, i).split('\n').length; };
  if (doc.Transform) out.transform = typeof doc.Transform === 'string' ? doc.Transform : 'declared';
  const resStart = t.indexOf('"Resources"');
  for (const [id, r] of Object.entries(doc.Resources || {})) {
    out.resources.push({ logicalId: id, type: r && typeof r.Type === 'string' ? r.Type : null, line: lineOf(id, Math.max(0, resStart)), text: JSON.stringify(r, null, 1), json: r });
  }
  const parStart = t.indexOf('"Parameters"');
  for (const [name, p] of Object.entries(doc.Parameters || {})) {
    out.parameters.push({ name, type: p.Type || 'String', default: p.Default === undefined ? undefined : String(p.Default), allowedValues: p.AllowedValues, allowedPattern: p.AllowedPattern, minValue: p.MinValue === undefined ? undefined : String(p.MinValue), line: lineOf(name, Math.max(0, parStart)) });
  }
  return out;
}

/** The value a resource's block declares for `prop` (a YAML or JSON scalar), or undefined when it does not declare it. */
export function declared(resource, prop) {
  if (resource.json) {
    const v = resource.json.Properties ? resource.json.Properties[prop] : undefined;
    return v === undefined ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const m = new RegExp(`^\\s*["']?${prop}["']?\\s*:(.*)$`, 'm').exec(resource.text);
  return m ? unquote(m[1]) : undefined;
}

/**
 * Values for the template's parameters so that it can be created in an emulator: its default, else the first allowed
 * value, else a placeholder that matches its pattern (or a number at its minimum). `missing` lists those it could not
 * fill (an AWS-specific type with no default, say): such a template is created anyway and its failure reported.
 */
export function parameterValues(params) {
  const values = [];
  const filled = [];
  const missing = [];
  for (const p of params) {
    if (p.default !== undefined) continue;
    let v;
    if (Array.isArray(p.allowedValues) && p.allowedValues.length) v = String(p.allowedValues[0]);
    else if (/^Number$/.test(p.type)) v = p.minValue !== undefined ? String(p.minValue) : '1';
    else if (/^(String|CommaDelimitedList|List<Number>)$/.test(p.type)) {
      const tries = ['maxwell-verify', 'maxwell', 'verify', 'a1', 'a', '1', 'verify.example.com'];
      let re = null;
      try { re = p.allowedPattern ? new RegExp(`^(?:${p.allowedPattern.replace(/^\^/, '').replace(/\$$/, '')})$`) : null; } catch { re = null; }
      v = re ? tries.find((x) => re.test(x)) : tries[0];
    }
    if (v === undefined) { missing.push(p.name); continue; }
    values.push({ ParameterKey: p.name, ParameterValue: v });
    filled.push({ name: p.name, value: v });
  }
  return { values, filled, missing };
}

/**
 * The template without its resources' Tags, for a second try in an emulator that failed on them (moto's KMS model, for
 * one). Tags change no security posture Maxwell reads back; the copy is written to a scratch file, never the checkout.
 */
export function withoutTags(text) {
  const t = text.replace(/^\uFEFF/, '');
  if (t.trimStart().startsWith('{')) {
    try {
      const doc = JSON.parse(t);
      for (const r of Object.values(doc.Resources || {})) if (r && r.Properties) delete r.Properties.Tags;
      return JSON.stringify(doc, null, 2);
    } catch { return t; }
  }
  const lines = t.split(/\r?\n/);
  const res = yamlSection(lines, 'Resources');
  if (!res) return t;
  const drop = new Set();
  for (let i = res[0] + 1; i < res[1]; i += 1) {
    if (!/^\s+["']?Tags["']?\s*:/.test(lines[i])) continue;
    const ind = indentOf(lines[i]);
    drop.add(i);
    for (let j = i + 1; j < res[1]; j += 1) {
      const l = lines[j];
      if (l.trim() && indentOf(l) < ind) break;
      if (l.trim() && indentOf(l) === ind && !/^\s*-\s/.test(l)) break;
      drop.add(j);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}
