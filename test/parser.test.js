'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractTags, extractAliases, extractLinkTargets, fmList, extractFrontmatter,
  resolveLink, buildIndex, buildGraph, normalizePath, makeNode
} = require('../lib/parser');

// ── Tags ──────────────────────────────────────────────────────────
test('inline hashtags are extracted', () => {
  assert.deepEqual(extractTags('Hello #project and #idea/sub here'), ['project', 'idea/sub']);
});

test('headings are not tags', () => {
  assert.deepEqual(extractTags('# Heading\n## Another\nText'), []);
});

test('purely numeric hashtags are ignored (Obsidian rule)', () => {
  assert.deepEqual(extractTags('Issue #42 but #v2 is fine'), ['v2']);
});

test('frontmatter inline tag list', () => {
  const c = '---\ntags: [alpha, beta]\n---\nBody';
  assert.deepEqual(extractTags(c).sort(), ['alpha', 'beta']);
});

test('frontmatter block tag list', () => {
  const c = '---\ntags:\n  - alpha\n  - beta\n---\nBody';
  assert.deepEqual(extractTags(c).sort(), ['alpha', 'beta']);
});

test('frontmatter scalar tag value', () => {
  const c = '---\ntag: solo\n---\nBody';
  assert.deepEqual(extractTags(c), ['solo']);
});

test('aliases list does NOT leak into tags', () => {
  const c = '---\ntags:\n  - real\naliases:\n  - NotATag\n---\nBody';
  assert.deepEqual(extractTags(c), ['real']);
});

// ── Aliases ───────────────────────────────────────────────────────
test('aliases are extracted from frontmatter', () => {
  const c = '---\naliases: [Nickname, "Other Name"]\n---\nBody';
  assert.deepEqual(extractAliases(c), ['Nickname', 'Other Name']);
});

test('singular alias key works', () => {
  const c = '---\nalias: Nick\n---\nBody';
  assert.deepEqual(extractAliases(c), ['Nick']);
});

// ── Link extraction ───────────────────────────────────────────────
test('wikilinks are extracted', () => {
  assert.deepEqual(extractLinkTargets('See [[Note A]] and [[Note B]]'), ['Note A', 'Note B']);
});

test('wikilink alias and heading are stripped', () => {
  assert.deepEqual(extractLinkTargets('[[Note A|shown text]] [[Note B#section]]'), ['Note A', 'Note B']);
});

test('embeds count as links', () => {
  assert.deepEqual(extractLinkTargets('![[Embedded Note]]'), ['Embedded Note']);
});

test('markdown links to .md files are extracted and decoded', () => {
  assert.deepEqual(extractLinkTargets('[text](My%20Note.md)'), ['My Note.md']);
  assert.deepEqual(extractLinkTargets('[x](sub/Other.md#h)'), ['sub/Other.md']);
});

test('markdown angle-bracket links work', () => {
  assert.deepEqual(extractLinkTargets('[t](<note name.md>)'), ['note name.md']);
});

test('http links are not graph links', () => {
  assert.deepEqual(extractLinkTargets('[site](https://example.com/page.md)'), []);
});

// ── Path normalization ────────────────────────────────────────────
test('normalizePath resolves .. and .', () => {
  assert.equal(normalizePath('a/b/../c/./d'), 'a/c/d');
  assert.equal(normalizePath('..\\up\\note'), 'up/note');
});

// ── Link resolution ───────────────────────────────────────────────
function idx(ids, aliases = {}) {
  const nodes = ids.map(id => ({ id, aliases: aliases[id] || [] }));
  return buildIndex(nodes);
}

test('exact path match wins', () => {
  const i = idx(['a/Note.md', 'b/Note.md']);
  assert.equal(resolveLink('a/Note', 'x/Source.md', i), 'a/Note.md');
});

test('duplicate basenames: same folder preferred', () => {
  const i = idx(['a/Note.md', 'b/Note.md']);
  assert.equal(resolveLink('Note', 'b/Source.md', i), 'b/Note.md');
});

test('duplicate basenames: shortest path as fallback', () => {
  const i = idx(['deep/nested/Note.md', 'top/Note.md']);
  assert.equal(resolveLink('Note', 'elsewhere/Source.md', i), 'top/Note.md');
});

test('relative ../ links resolve', () => {
  const i = idx(['a/Note.md', 'b/Source.md']);
  assert.equal(resolveLink('../a/Note', 'b/Source.md', i), 'a/Note.md');
});

test('suffix path match resolves partial paths', () => {
  const i = idx(['projects/2026/Plan.md']);
  assert.equal(resolveLink('2026/Plan', 'Source.md', i), 'projects/2026/Plan.md');
});

test('alias resolution', () => {
  const i = idx(['notes/Long Official Title.md'], { 'notes/Long Official Title.md': ['LOT'] });
  assert.equal(resolveLink('LOT', 'Source.md', i), 'notes/Long Official Title.md');
});

test('case-insensitive resolution', () => {
  const i = idx(['Folder/MyNote.md']);
  assert.equal(resolveLink('mynote', 'Source.md', i), 'Folder/MyNote.md');
});

test('unresolvable links return null', () => {
  const i = idx(['a/Note.md']);
  assert.equal(resolveLink('DoesNotExist', 'a/Note.md', i), null);
});

// ── Graph assembly ────────────────────────────────────────────────
test('buildGraph produces nodes and deduplicated links', () => {
  const files = [
    { id: 'A.md', content: 'Link to [[B]] and again [[B]] and [[B#sec]]', mtimeMs: 1, size: 10 },
    { id: 'B.md', content: 'Back to [[A]]', mtimeMs: 2, size: 10 },
    { id: 'C.md', content: 'Orphan, no links', mtimeMs: 3, size: 10 }
  ];
  const g = buildGraph(files);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(
    g.links.map(l => l.source + '>' + l.target).sort(),
    ['A.md>B.md', 'B.md>A.md']
  );
});

test('self-links are ignored', () => {
  const g = buildGraph([{ id: 'A.md', content: '[[A]]', mtimeMs: 1, size: 5 }]);
  assert.equal(g.links.length, 0);
});

test('makeNode extracts heading and word count', () => {
  const n = makeNode('x/Test.md', '# My Heading\n\nthree little words', { mtimeMs: 5, size: 30 });
  assert.equal(n.name, 'Test');
  assert.equal(n.heading, 'My Heading');
  assert.equal(n.wordCount, 6);
  assert.equal(n.mtime, 5);
});

test('frontmatter is tolerated with CRLF line endings', () => {
  const c = '---\r\ntags: [win]\r\n---\r\nBody #extra';
  assert.deepEqual(extractTags(c).sort(), ['extra', 'win']);
});

// ── Async scanning (Issue #1: no synchronous fs in the scan path) ──
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listMdFilesAsync, scanVaultAsync, parseVaultAsync } = require('../lib/parser');

function makeTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odw-test-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\n[[b]] #x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# B\nbody');
  fs.mkdirSync(path.join(dir, '.obsidian'));        // dot-dir must be ignored
  fs.writeFileSync(path.join(dir, '.obsidian', 'skip.md'), 'should not appear');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not markdown');
  return dir;
}

test('listMdFilesAsync finds .md recursively and skips dot-dirs and non-md', async () => {
  const dir = makeTempVault();
  try {
    const files = (await listMdFilesAsync(dir)).map(p => path.basename(p)).sort();
    assert.deepEqual(files, ['a.md', 'b.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanVaultAsync reports progress and reaches done === total', async () => {
  const dir = makeTempVault();
  try {
    const events = [];
    const files = await scanVaultAsync(dir, 32, (done, total) => events.push([done, total]));
    assert.equal(files.length, 2);
    const last = events[events.length - 1];
    assert.equal(last[0], last[1]);     // final event: done === total
    assert.equal(last[1], 2);           // total counts only the 2 real notes
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseVaultAsync resolves links across folders', async () => {
  const dir = makeTempVault();
  try {
    const g = await parseVaultAsync(dir);
    assert.equal(g.nodes.length, 2);
    assert.equal(g.links.length, 1);    // a.md -> sub/b.md
    assert.equal(g.links[0].source, 'a.md');
    assert.equal(g.links[0].target, 'sub/b.md');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
