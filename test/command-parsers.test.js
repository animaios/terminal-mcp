import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandName, parseCommandOutput, summarizeCommandOutput } from '../src/command-parsers.js';

test('normalizeCommandName returns lowercase basename', () => {
  assert.equal(normalizeCommandName('git'), 'git');
  assert.equal(normalizeCommandName('bash'), 'bash');
  assert.equal(normalizeCommandName('/usr/bin/python'), 'python');
  assert.equal(normalizeCommandName('Git'), 'git');
});

test('parseCommandOutput parses git log --oneline', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline'],
    stdout: 'a1b2c3d Add parser\nffeedd0 Fix tests\n',
  });

  assert.deepEqual(parsed, {
    commits: [
      { hash: 'a1b2c3d', message: 'Add parser' },
      { hash: 'ffeedd0', message: 'Fix tests' },
    ],
  });
});

test('parseCommandOutput parses git log --oneline with max-count variants', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline', '-n', '2'],
    stdout: 'a1b2c3d Add parser\nffeedd0 Fix tests\n',
  });

  assert.deepEqual(parsed, {
    commits: [
      { hash: 'a1b2c3d', message: 'Add parser' },
      { hash: 'ffeedd0', message: 'Fix tests' },
    ],
  });
});

test('parseCommandOutput parses git status porcelain output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '--porcelain=v1', '--branch'],
    stdout: '## main...origin/main [ahead 2]\nM  staged.txt\n M modified.txt\n?? new file.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: { head: 'main', upstream: 'origin/main', ahead: 2 },
    staged: ['staged.txt'],
    modified: ['modified.txt'],
    untracked: ['new file.txt'],
  });
});

test('parseCommandOutput parses git status short aliases', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '-b', '--short'],
    stdout: '## feature...origin/feature [ahead 1, behind 2]\n M changed.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: { head: 'feature', upstream: 'origin/feature', ahead: 1, behind: 2 },
    staged: [],
    modified: ['changed.txt'],
    untracked: [],
  });
});

test('parseCommandOutput parses git status --short without branch metadata', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '--short'],
    stdout: 'M  staged.txt\n M modified.txt\n?? new file.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: null,
    staged: ['staged.txt'],
    modified: ['modified.txt'],
    untracked: ['new file.txt'],
  });
});

test('parseCommandOutput parses git branch output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch'],
    stdout: '* main\n  feature/test\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      { name: 'main', current: true },
      { name: 'feature/test', current: false },
    ],
  });
});

test('parseCommandOutput parses git branch --all output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '--all'],
    stdout: '* main\n  remotes/origin/main\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      { name: 'main', current: true },
      { name: 'remotes/origin/main', current: false },
    ],
  });
});

test('parseCommandOutput parses git branch -vv output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '-vv'],
    stdout: '* main abc1234 [origin/main: ahead 1] Main branch\n  old fedcba9 [origin/old: gone] Old branch\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      {
        name: 'main',
        current: true,
        commit: 'abc1234',
        upstream: 'origin/main',
        ahead: 1,
        message: 'Main branch',
      },
      {
        name: 'old',
        current: false,
        commit: 'fedcba9',
        upstream: 'origin/old',
        gone: true,
        message: 'Old branch',
      },
    ],
  });
});

test('parseCommandOutput parses git branch --show-current', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '--show-current'],
    stdout: 'main\n',
  });

  assert.deepEqual(parsed, { current: 'main' });
});

test('parseCommandOutput parses git rev-parse --abbrev-ref HEAD', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    stdout: 'main\n',
  });

  assert.deepEqual(parsed, { current: 'main' });
});

test('parseCommandOutput parses git rev-parse --show-toplevel', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--show-toplevel'],
    stdout: 'C:/repo\n',
  });

  assert.deepEqual(parsed, { topLevel: 'C:/repo' });
});

test('parseCommandOutput parses git rev-parse --is-inside-work-tree', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    stdout: 'true\n',
  });

  assert.deepEqual(parsed, { isInsideWorkTree: true });
});

test('parseCommandOutput parses git diff --name-only', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--cached', '--name-only'],
    stdout: 'src/index.js\nREADME.md\n',
  });

  assert.deepEqual(parsed, {
    paths: ['src/index.js', 'README.md'],
  });
});

test('parseCommandOutput parses git diff --name-status', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--name-status'],
    stdout: 'M\tsrc/index.js\nR100\told-name.js\tnew-name.js\n',
  });

  assert.deepEqual(parsed, {
    changes: [
      { status: 'M', path: 'src/index.js' },
      { status: 'R100', path: 'new-name.js', previousPath: 'old-name.js' },
    ],
  });
});

test('parseCommandOutput parses git diff --stat', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--stat'],
    stdout: ' src/index.js | 2 +-\n README.md    | 3 ++-\n 2 files changed, 3 insertions(+), 2 deletions(-)\n',
  });

  assert.deepEqual(parsed, {
    files: [
      { path: 'src/index.js', changes: 2, histogram: '+-' },
      { path: 'README.md', changes: 3, histogram: '++-' },
    ],
    summary: {
      filesChanged: 2,
      insertions: 3,
      deletions: 2,
    },
  });
});

test('parseCommandOutput parses git diff --shortstat', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--shortstat'],
    stdout: ' 2 files changed, 3 insertions(+), 2 deletions(-)\n',
  });

  assert.deepEqual(parsed, {
    summary: {
      filesChanged: 2,
      insertions: 3,
      deletions: 2,
    },
  });
});

test('parseCommandOutput parses git remote -v output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['remote', '-v'],
    stdout: 'origin\thttps://github.com/example/repo.git (fetch)\norigin\thttps://github.com/example/repo.git (push)\n',
  });

  assert.deepEqual(parsed, {
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/example/repo.git',
        pushUrl: 'https://github.com/example/repo.git',
      },
    ],
  });
});

test('parseCommandOutput parses which output as paths', () => {
  const parsed = parseCommandOutput({
    cmd: 'which',
    args: ['git'],
    stdout: '/usr/bin/git\n/usr/local/bin/git\n',
  });

  assert.deepEqual(parsed, {
    paths: [
      '/usr/bin/git',
      '/usr/local/bin/git',
    ],
  });
});

test('parseCommandOutput parses git ls-files as paths', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['ls-files'],
    stdout: 'src/index.js\nREADME.md\n',
  });

  assert.deepEqual(parsed, {
    paths: ['src/index.js', 'README.md'],
  });
});

test('summarizeCommandOutput returns counts for supported parsed output', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['status', '--short'],
    parsed: {
      branch: { head: 'main', upstream: 'origin/main', ahead: 1 },
      staged: ['staged.txt'],
      modified: ['modified.txt'],
      untracked: ['new.txt'],
    },
  });

  assert.deepEqual(summary, {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    stagedCount: 1,
    modifiedCount: 1,
    untrackedCount: 1,
  });
});

test('parseCommandOutput returns null for unsupported commands', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['show'],
    stdout: 'raw output',
  });

  assert.equal(parsed, null);
});

test('summarizeCommandOutput summarizes git branch list', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['branch'],
    parsed: {
      branches: [
        { name: 'main', current: true },
        { name: 'feature', current: false },
      ],
    },
  });

  assert.deepEqual(summary, { branchCount: 2, current: 'main' });
});

test('summarizeCommandOutput summarizes git branch --show-current', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['branch', '--show-current'],
    parsed: { current: 'develop' },
  });

  assert.deepEqual(summary, { current: 'develop' });
});

test('summarizeCommandOutput returns null for git branch with no current', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['branch'],
    parsed: {
      branches: [
        { name: 'main', current: false },
        { name: 'old', current: false },
      ],
    },
  });

  assert.deepEqual(summary, { branchCount: 2 });
});

test('summarizeCommandOutput summarizes git diff --shortstat', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['diff', '--shortstat'],
    parsed: { summary: { filesChanged: 3, insertions: 10, deletions: 5 } },
  });

  assert.deepEqual(summary, { filesChanged: 3, insertions: 10, deletions: 5 });
});

test('summarizeCommandOutput summarizes git diff --name-only paths', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['diff', '--name-only'],
    parsed: { paths: ['a.js', 'b.js', 'c.js'] },
  });

  assert.deepEqual(summary, { pathCount: 3 });
});

test('summarizeCommandOutput summarizes git diff --stat files', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['diff', '--stat'],
    parsed: { files: [{ path: 'a.js', changes: 2, histogram: '+-' }] },
  });

  assert.deepEqual(summary, { fileCount: 1 });
});

test('summarizeCommandOutput summarizes git diff --name-status changes', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['diff', '--name-status'],
    parsed: {
      changes: [
        { status: 'M', path: 'a.js' },
        { status: 'M', path: 'b.js' },
        { status: 'A', path: 'c.js' },
      ],
    },
  });

  assert.deepEqual(summary, { changeCount: 3, statuses: { M: 2, A: 1 } });
});

test('summarizeCommandOutput returns null for unknown git diff parsed shape', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['diff'],
    parsed: {},
  });

  assert.equal(summary, null);
});

test('summarizeCommandOutput summarizes git log commits', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline'],
    parsed: {
      commits: [
        { hash: 'abc1234', message: 'First commit' },
        { hash: 'def5678', message: 'Second commit' },
      ],
    },
  });

  assert.deepEqual(summary, {
    commitCount: 2,
    latestCommit: { hash: 'abc1234', message: 'First commit' },
  });
});

test('summarizeCommandOutput summarizes git log with empty commits', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline'],
    parsed: { commits: [] },
  });

  assert.deepEqual(summary, { commitCount: 0 });
});

test('summarizeCommandOutput summarizes git rev-parse', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--show-toplevel'],
    parsed: { topLevel: '/repo' },
  });

  assert.deepEqual(summary, { topLevel: '/repo' });
});

test('summarizeCommandOutput summarizes git ls-files', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['ls-files'],
    parsed: { paths: ['a.js', 'b.js'] },
  });

  assert.deepEqual(summary, { pathCount: 2 });
});

test('summarizeCommandOutput summarizes git remote -v', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['remote', '-v'],
    parsed: {
      remotes: [
        { name: 'origin', fetchUrl: 'https://a.com', pushUrl: 'https://a.com' },
        { name: 'upstream', fetchUrl: 'https://b.com', pushUrl: 'https://b.com' },
      ],
    },
  });

  assert.deepEqual(summary, { remoteCount: 2, names: ['origin', 'upstream'] });
});

test('summarizeCommandOutput summarizes which', () => {
  const summary = summarizeCommandOutput({
    cmd: 'which',
    args: ['node'],
    parsed: { paths: ['/usr/bin/node'] },
  });

  assert.deepEqual(summary, { pathCount: 1 });
});

test('summarizeCommandOutput returns null for unknown commands', () => {
  const summary = summarizeCommandOutput({
    cmd: 'ls',
    args: [],
    parsed: { files: [] },
  });

  assert.equal(summary, null);
});

test('summarizeCommandOutput returns null when parsed is null', () => {
  const summary = summarizeCommandOutput({
    cmd: 'git',
    args: ['status'],
    parsed: null,
  });

  assert.equal(summary, null);
});

test('parseCommandOutput parses git diff --stat without summary line', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--stat'],
    stdout: ' src/index.js | 2 +-\n README.md    | 3 ++-\n',
  });

  assert.deepEqual(parsed, {
    files: [
      { path: 'src/index.js', changes: 2, histogram: '+-' },
      { path: 'README.md', changes: 3, histogram: '++-' },
    ],
  });
});

test('parseCommandOutput returns null for empty git diff --stat', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--stat'],
    stdout: '',
  });

  assert.equal(parsed, null);
});

test('parseCommandOutput parses git rev-parse --is-inside-work-tree false', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    stdout: 'false\n',
  });

  assert.deepEqual(parsed, { isInsideWorkTree: false });
});

test('parseCommandOutput returns null for non-true/false boolean', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    stdout: 'maybe\n',
  });

  assert.equal(parsed, null);
});