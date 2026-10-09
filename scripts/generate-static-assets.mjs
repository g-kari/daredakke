import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve('dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const files = {}, manifest = {};
let total = 0;
const rootInfo = fs.lstatSync(root);
if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('asset_root_must_be_directory');
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('asset_symlink_not_supported');
    if (entry.isDirectory()) { visit(absolute); continue; }
    if (!entry.isFile()) throw new Error('unsupported_asset');
    const name = '/' + path.relative(root, absolute).split(path.sep).join('/');
    const contentType = types[path.extname(name)];
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..') || !contentType) throw new Error('unsupported_asset_name_or_type');
    if (fs.statSync(absolute).size > 1000000 - total || Object.keys(files).length >= 100) throw new Error('bundled_asset_budget_exceeded');
    const bytes = fs.readFileSync(absolute), body = bytes.toString('utf8');
    if (!Buffer.from(body, 'utf8').equals(bytes)) throw new Error('binary_asset_not_supported');
    total += bytes.length;
    if (total > 1000000 || Object.keys(files).length >= 100) throw new Error('bundled_asset_budget_exceeded');
    files[name] = { body, contentType };
    manifest[name] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentType };
  }
}
visit(root);
if (!Object.hasOwn(files, '/index.html')) throw new Error('missing_index');
fs.mkdirSync('.generated', { recursive: true });
fs.writeFileSync('.generated/static-assets.generated.json', JSON.stringify(files));
fs.writeFileSync('.generated/static-assets.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ files: Object.keys(files).length, bytes: total, result: 'generated bounded UTF-8 static bundle' }));
