#!/usr/bin/env node
/**
 * Static safety scan: fails (exit 1) if the source tree or dependency manifests
 * contain anything resembling transaction signing, wallet handling or swap
 * execution. Run with:  npm run verify:no-real-trading
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIRS = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];
const MANIFESTS = ['package.json', 'apps/api/package.json', 'apps/web/package.json', 'packages/shared/package.json'];

const CODE_PATTERNS = [
  [/@solana\/web3\.js|@solana\/kit|@coral-xyz\/anchor/, 'Solana SDK import'],
  [/\b(sendTransaction|sendRawTransaction|signTransaction|signAllTransactions)\b/, 'transaction send/sign call'],
  [/\b(Keypair|fromSecretKey|secretKey)\b/, 'keypair / secret key handling'],
  [/\bbs58\b|tweetnacl/, 'key encoding / signing library'],
  [/pumpportal\.fun\/api\/trade|jup\.ag\/swap|quote-api\.jup\.ag/, 'swap execution endpoint'],
];
const DEP_PATTERN = /"(@solana\/[^"]+|@coral-xyz\/anchor|bs58|tweetnacl|@jup-ag\/[^"]+)"\s*:/;

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(f) ? [p] : [];
  });

const findings = [];
for (const d of SOURCE_DIRS) {
  for (const file of walk(join(root, d))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, what] of CODE_PATTERNS) {
        if (re.test(line)) findings.push(`${relative(root, file)}:${i + 1}  ${what}: ${line.trim()}`);
      }
    });
  }
}
for (const m of MANIFESTS) {
  const text = readFileSync(join(root, m), 'utf8');
  const hit = text.match(DEP_PATTERN);
  if (hit) findings.push(`${m}  forbidden dependency: ${hit[1]}`);
}

if (findings.length) {
  console.error('Real-trading safety scan FAILED:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`Real-trading safety scan passed: scanned ${SOURCE_DIRS.join(', ')} and ${MANIFESTS.length} manifests.`);
console.log('No signing, wallet, private-key or swap-execution code or dependencies found.');
