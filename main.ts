// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. The starter's sections 1 to 4, 9 and 10 are kept
// as the kit shipped them (command line, output and exit codes, safe paths, format detection, JSON
// edits, all-or-nothing write); sections 5 to 8 (matching tiers, unified diffs, SEARCH/REPLACE
// blocks, V4A patches) and the `R old -> new` output line for moves are written here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** A file's text as lines, with its own line break and whether it ends with one. */
interface FileView {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.final ? v.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineMatches(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs in `lines`, with every occurrence position. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O of the matching context line, for ctx lines. */
  oIdx: number;
}

/** Replace O at `pos` with N, applying section 5's context and tier-2 re-indent rules. */
function applyReplace(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  const out = n.map((nl) => {
    if (nl.ctx) return lines[pos + nl.oIdx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

type BodyKind = ' ' | '-' | '+' | '\\' | '';

interface BodyLine {
  kind: BodyKind;
  text: string;
  /** The raw patch line, for telling blank lines from empty context lines. */
  raw: string;
}

interface Hunk {
  /** Old start line from the header (1-based). */
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  hasHeaderPaths: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Split a hunk body starting at `start`; returns the body and the next line index. */
function parseHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: '', text: '', raw: l });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c as BodyKind, text: l.slice(1), raw: l });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, next: i };
}

/** O and N of a hunk, with context lines mapped to their O index. */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const oCtxIdx: number[] = [];
  for (const b of h.body) {
    if (b.kind === '\\') continue;
    if (b.kind === ' ' || b.kind === '') {
      o.push(b.text);
      oCtxIdx.push(o.length - 1);
    } else if (b.kind === '-') {
      o.push(b.text);
    }
  }
  const n: NLine[] = [];
  let ctxSeen = 0;
  for (const b of h.body) {
    if (b.kind === '\\') continue;
    if (b.kind === ' ' || b.kind === '') {
      n.push({ text: b.text, ctx: true, oIdx: oCtxIdx[ctxSeen]! });
      ctxSeen += 1;
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: Hunk): boolean {
  const b = h.body;
  for (let j = b.length - 1; j >= 0; j--) {
    if (b[j]!.kind === ' ' || b[j]!.kind === '' || b[j]!.kind === '+') {
      return b[j + 1]?.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const view = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const at = Math.min(h.a + d, view.lines.length);
      const atEnd = at === view.lines.length;
      view.lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) view.final = !backslashAfterLast(h);
      d += n.length;
      continue;
    }
    const found = findTier(view.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bd = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bd) {
        best = p;
        bd = dist;
      }
    }
    const atEnd = best + o.length === view.lines.length;
    view.lines = applyReplace(view.lines, best, o, n, found.tier);
    if (atEnd) view.final = !backslashAfterLast(h);
    d += n.length - o.length;
  }
  return joinFile(view);
}

function makeUnifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.hasHeaderPaths ? sec.headerOld : (sec.renameFrom ?? sec.diffOld);
    const newPath = sec.hasHeaderPaths ? sec.headerNew : (sec.renameTo ?? sec.diffNew);
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreate = sec.newFileMode || oldPath === null;
    const isDelete = sec.deletedFileMode || newPath === null;
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let j = body.length - 1; j >= 0; j--) {
          if (body[j]!.kind === '+') {
            noBreak = body[j + 1]?.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldPath === null) throw new Fail('unsafe', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (op !== np) {
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(text, sec.hunks, strict, op));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    sec = {
      diffOld,
      diffNew,
      headerOld: null,
      headerNew: null,
      hasHeaderPaths: false,
      renameFrom: null,
      renameTo: null,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    inHeader = true;
  };
  const finishSection = (): void => {
    if (sec !== null) edits.push(makeUnifiedSectionEdit(sec, strict));
    sec = null;
    inHeader = false;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && inHeader) {
        sec.headerOld = headerPath(l);
        sec.headerNew = headerPath(lines[i + 1]!);
        sec.hasHeaderPaths = true;
        i += 2;
        continue;
      }
      finishSection();
      startSection(null, null);
      sec!.headerOld = headerPath(l);
      sec!.headerNew = headerPath(lines[i + 1]!);
      sec!.hasHeaderPaths = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      sec.hunks.push({ a: parseInt(hm[1]!, 10), body });
      inHeader = false;
      i = next;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFileMode = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deletedFileMode = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const view = splitFile(text);
    const found = findTier(view.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    const n = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }) as NLine);
    view.lines = applyReplace(view.lines, found.pos[0]!, oldLines, n, found.tier);
    tree.now.set(path, joinFile(view));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function chunkON(ch: V4aChunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const oCtxIdx: number[] = [];
  for (const b of ch.body) {
    if (b.kind === ' ' || b.kind === '') {
      o.push(b.text);
      oCtxIdx.push(o.length - 1);
    } else if (b.kind === '-') {
      o.push(b.text);
    }
  }
  const n: NLine[] = [];
  let ctxSeen = 0;
  for (const b of ch.body) {
    if (b.kind === ' ' || b.kind === '') {
      n.push({ text: b.text, ctx: true, oIdx: oCtxIdx[ctxSeen]! });
      ctxSeen += 1;
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const view = splitFile(text);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        for (const t of tiers) {
          for (let i = cursor; i < view.lines.length; i++) {
            if (lineMatches(view.lines[i]!, ch.anchor, t)) {
              foundAt = i;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { o, n } = chunkON(ch);
      if (o.length === 0) {
        const at = ch.eof ? view.lines.length : cursor;
        view.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
        continue;
      }
      let found: { tier: number; pos: number[] } | null = null;
      for (const t of tiers) {
        const pos = occurrences(view.lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === view.lines.length));
        if (pos.length > 0) {
          found = { tier: t, pos };
          break;
        }
      }
      if (!found) throw new Fail('no-match', path);
      const p0 = found.pos[0]!;
      view.lines = applyReplace(view.lines, p0, o, n, found.tier);
      cursor = p0 + n.length;
    }
    const out = joinFile(view);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l === '*** Add File:' || l.startsWith('*** Add File: ')) return 'add';
    if (l === '*** Delete File:' || l.startsWith('*** Delete File: ')) return 'delete';
    if (l === '*** Update File:' || l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (l: string): string => l.slice(l.indexOf(':') + 1).trim();
  const isMoveTo = (l: string): boolean => l === '*** Move to:' || l.startsWith('*** Move to: ');
  let i = first + 1;
  const end = last;
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const kind = isSectionStart(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = sectionPath(lines[i]!);
    const headerLine = i;
    i++;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l) !== null) break;
        if (l.startsWith('+')) {
          raw.push(l);
          i++;
          continue;
        }
        if (blank(l)) {
          raw.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(makeV4aAddEdit(path, raw.map((l) => (l.startsWith('+') ? l.slice(1) : ''))));
    } else if (kind === 'delete') {
      edits.push(makeV4aDeleteEdit(path));
    } else {
      while (i < end && blank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < end && isMoveTo(lines[i]!)) {
        moveTo = sectionPath(lines[i]!);
        i++;
        while (i < end && blank(lines[i]!)) i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          pushCur();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          pushCur();
          i++;
          continue;
        }
        if (isSectionStart(l) !== null) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, body: [] };
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          cur.body.push({ kind: l === '' ? '' : (l[0] as BodyKind), text: l === '' ? '' : l.slice(1), raw: l });
          i++;
          continue;
        }
        if (blank(l)) {
          if (cur !== null) {
            cur.body.push({ kind: '', text: '', raw: l });
            i++;
            continue;
          }
          if (chunks.length === 0) {
            cur = { anchor: null, eof: false, body: [{ kind: '', text: '', raw: l }] };
            i++;
            continue;
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushCur();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!.raw)) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPairs: [string, string][] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.push([oldP, newP]);
    }
  }
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  const outRows: { sort: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    outRows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) outRows.push({ sort: n, line: `R ${o} -> ${n}` });
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  const rows = outRows.map((r) => r.line);
  if (!check) {
    // Write every change once. A move pair's new side is written in the loop below, so it is
    // skipped here; its old side is removed here like any other deletion.
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      const was = tree.original(p);
      if (was === now) continue;
      if (rNew.has(p) && !rOld.has(p)) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    for (const [, n] of rPairs) {
      const now = tree.now.get(n)!;
      mkdirSync(dirname(n), { recursive: true });
      writeFileSync(n, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
