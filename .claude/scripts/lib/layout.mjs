// Layout manifest helpers: glob matching and workspace walking with the same semantics for every validator.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const LAYOUT_PATH = '.claude/schemas/layout.json';

export function loadLayout(path = LAYOUT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Converts a layout glob to a RegExp. '**' matches across segments, '*' within one segment.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more directories; trailing '**' matches anything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchRule(layout, relPath) {
  const candidates = [];
  for (const rule of layout.rules) {
    if (!globToRegExp(rule.glob).test(relPath)) continue;
    if (rule.exclude && rule.exclude.some((ex) => globToRegExp(ex).test(relPath) || globToRegExp(ex).test(relPath.split('/').pop()))) continue;
    candidates.push(rule);
  }
  if (candidates.length === 0) return null;
  // Most specific rule wins: fewest wildcards, then longest glob.
  candidates.sort((a, b) => {
    const wa = (a.glob.match(/\*/g) || []).length;
    const wb = (b.glob.match(/\*/g) || []).length;
    if (wa !== wb) return wa - wb;
    return b.glob.length - a.glob.length;
  });
  return candidates[0];
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

// Walks the workspace and yields {relPath, isDir, isSymlink}. Gitignored application checkouts are skipped.
export function walkWorkspace(root = '.') {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir).sort()) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      const abs = join(dir, entry);
      // node_modules and .git are skipped by name whatever their type: a git worktree has a .git file and
      // node_modules may be a symlink to a shared install.
      if (!rel && SKIP_DIRS.has(entry)) continue;
      const st = lstatSync(abs);
      const isSymlink = st.isSymbolicLink();
      if (st.isDirectory() && !isSymlink) {
        if (SKIP_DIRS.has(entry)) continue;
        // applications/<app>/repos/<repo>/ checkouts are gitignored and not validated.
        if (/^applications\/[^/]+\/repos\/[^/]+$/.test(relPath)) { out.push({ relPath, isDir: true, isSymlink: false, checkout: true }); continue; }
        out.push({ relPath, isDir: true, isSymlink: false });
        walk(abs, relPath);
      } else {
        out.push({ relPath, isDir: false, isSymlink });
      }
    }
  };
  walk(root, '');
  return out;
}
