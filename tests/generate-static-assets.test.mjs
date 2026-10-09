import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const script = new URL('../scripts/generate-static-assets.mjs', import.meta.url);
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daredakke-assets-test-'));
  fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
  try { run(root, file => path.join(root, 'dist', file)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function generate(root) { return spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: 'utf8' }); }
test('static generator preserves UTF-8 bytes, content types and hashes deterministically', () => fixture((root, file) => {
  const content = '<!doctype html><title>だれだっけ</title>';
  fs.writeFileSync(file('index.html'), content);
  fs.writeFileSync(file('assets/app.js'), 'console.log("synthetic");');
  assert.equal(generate(root).status, 0);
  const generated = fs.readFileSync(path.join(root, '.generated/static-assets.generated.json'), 'utf8');
  const data = JSON.parse(generated), manifest = JSON.parse(fs.readFileSync(path.join(root, '.generated/static-assets.manifest.json'), 'utf8'));
  assert.equal(data['/index.html'].body, content);
  assert.equal(data['/index.html'].contentType, 'text/html; charset=utf-8');
  assert.equal(manifest['/index.html'].bytes, Buffer.byteLength(content));
  assert.equal(manifest['/index.html'].sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(generate(root).status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.generated/static-assets.generated.json'), 'utf8'), generated);
}));
test('static generator refuses symlinks, unsupported/binary files, missing index and oversized assets', () => {
  for (const failure of ['symlink', 'root-symlink', 'binary', 'missing-index', 'oversized', 'unsafe-name']) fixture((root, file) => {
    if (failure !== 'missing-index') fs.writeFileSync(file('index.html'), '<!doctype html>');
    if (failure === 'symlink') fs.symlinkSync(file('index.html'), file('alias.html'));
    if (failure === 'root-symlink') { fs.renameSync(path.join(root, 'dist'), path.join(root, 'source')); fs.symlinkSync(path.join(root, 'source'), path.join(root, 'dist')); }
    if (failure === 'binary') fs.writeFileSync(file('assets/bad.js'), Buffer.from([0xff, 0xfe]));
    if (failure === 'oversized') fs.writeFileSync(file('assets/big.js'), 'a'.repeat(1000001));
    if (failure === 'unsafe-name') fs.writeFileSync(file('assets/with space.js'), 'synthetic');
    assert.notEqual(generate(root).status, 0, failure);
    assert.equal(fs.existsSync(path.join(root, '.generated/static-assets.generated.json')), false, failure);
  });
});
