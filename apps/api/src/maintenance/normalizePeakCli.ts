/**
 * One-time peak-basis normalization (see maintenance/peakNormalization.ts).
 *
 *   Dry run (read-only, default):  npx tsx src/maintenance/normalizePeakCli.ts [--db data/paper.db]
 *   Apply (API must be STOPPED):   npx tsx src/maintenance/normalizePeakCli.ts --apply [--db data/paper.db] [--backup-dir data/backups]
 *
 * --apply: refuses while the API port answers; takes an SQLite online backup, verifies it
 * (integrity_check + fingerprints + test-restore into a temp copy), then updates only
 * positions' peakPriceSol in one transaction and verifies nothing else changed.
 */
import 'dotenv/config';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/env';
import { applyPeakNormalization, fingerprints, planPeakNormalization, type PeakPlanRow } from './peakNormalization';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'data/paper.db' },
    apply: { type: 'boolean', default: false },
    'backup-dir': { type: 'string', default: 'data/backups' },
    'skip-port-check': { type: 'boolean', default: false }, // only for operating on a COPY
  },
});

const cfg = loadConfig();
const dbPath = resolve(values.db!);

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port, timeout: 1000 }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
    s.on('timeout', () => {
      s.destroy();
      res(false);
    });
  });
}

function printPlan(plan: PeakPlanRow[]) {
  if (!plan.length) return console.log('No open positions: nothing to normalize.');
  for (const r of plan) {
    console.log(`\n${r.symbol} ${r.mint}`);
    console.log(`  stored peak (old basis)   : ${r.oldPeak}`);
    console.log(`  exit reference (new basis): ${r.exitReference ?? 'n/a'}${r.observationAt ? `  (latest recorded observation ${new Date(r.observationAt).toISOString()})` : ''}`);
    console.log(`  normalized peak           : ${r.newPeak}  ${r.changed ? 'CHANGE' : 'no change'}${r.skippedReason ? `  [skipped: ${r.skippedReason}]` : ''}`);
    console.log(`  exit decision, old peak   : ${r.exitBefore}`);
    console.log(`  exit decision, normalized : ${r.exitAfter}`);
  }
}

if (!values.apply) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  console.log(`DRY RUN (read-only) on ${dbPath}`);
  printPlan(planPeakNormalization(db, cfg.costs));
  console.log('\nfingerprints:', JSON.stringify(fingerprints(db)));
  db.close();
  process.exit(0);
}

// ---------------- apply ----------------
if (!values['skip-port-check'] && (await portOpen(cfg.host, cfg.port))) {
  console.error(`Refusing to apply: the API is answering on ${cfg.host}:${cfg.port}. Stop the app first.`);
  process.exit(2);
}

// 1. Backup + verification
const src = new Database(dbPath, { readonly: true, fileMustExist: true });
const srcPrints = fingerprints(src);
const backupDir = resolve(values['backup-dir']!);
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `paper-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
await src.backup(backupPath);
src.close();
const bak = new Database(backupPath, { readonly: true, fileMustExist: true });
const integrity = bak.pragma('integrity_check', { simple: true });
const bakPrints = fingerprints(bak);
bak.close();
if (integrity !== 'ok' || JSON.stringify(bakPrints) !== JSON.stringify(srcPrints)) {
  console.error('Backup verification FAILED; nothing was written.', { integrity, srcPrints, bakPrints });
  process.exit(3);
}
// Test-restore: copy the backup elsewhere and open it like the app would.
const restoreDir = mkdtempSync(join(tmpdir(), 'spb-restore-test-'));
copyFileSync(backupPath, join(restoreDir, 'paper.db'));
const restored = new Database(join(restoreDir, 'paper.db'), { fileMustExist: true });
const restoredOk = restored.pragma('integrity_check', { simple: true }) === 'ok' && JSON.stringify(fingerprints(restored)) === JSON.stringify(srcPrints);
restored.close();
rmSync(restoreDir, { recursive: true, force: true });
if (!restoredOk) {
  console.error('Test-restore FAILED; nothing was written.');
  process.exit(4);
}
console.log(`Backup verified and test-restored: ${backupPath}`);

// 2. Plan + apply
const db = new Database(dbPath, { fileMustExist: true });
const plan = planPeakNormalization(db, cfg.costs);
printPlan(plan);
const result = applyPeakNormalization(db, plan);
db.close();
console.log(`\nUpdated ${result.updated} position(s). Unchanged: orders, audit log, kv (cash, realized P&L, peak equity, kill switch, config) and all other position fields.`);
console.log('before:', JSON.stringify(result.before));
console.log('after :', JSON.stringify(result.after));
console.log(`\nTo restore: stop the app, copy "${backupPath}" over "${dbPath}" and delete "${dbPath}-wal" and "${dbPath}-shm" if present.`);
