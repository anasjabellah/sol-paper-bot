import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoUnsafeEnv, loadConfig } from '../src/config/env';
import { redactDbUrl, toPgPlaceholders } from '../src/database/db';

describe('environment safety', () => {
  it('refuses wallet secrets and real-trading flags', () => {
    for (const env of [
      { SOLANA_PRIVATE_KEY: 'abc' },
      { WALLET_SEED_PHRASE: 'a b c' },
      { MNEMONIC: 'x' },
      { ENABLE_REAL_TRADING: 'true' },
      { LIVE_TRADING: '1' },
      { KEYPAIR_PATH: '~/.config/solana/id.json' },
    ]) {
      expect(() => assertNoUnsafeEnv(env), JSON.stringify(env)).toThrow(/paper-trading-only/);
    }
    expect(() => assertNoUnsafeEnv({ PRIVATE_KEY: '' })).not.toThrow();
  });

  it('refuses non-loopback binding without a strong auth token', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/API_AUTH_TOKEN/);
    expect(() => loadConfig({ HOST: '0.0.0.0', API_AUTH_TOKEN: 'short' })).toThrow(/API_AUTH_TOKEN/);
    expect(loadConfig({ HOST: '0.0.0.0', API_AUTH_TOKEN: 'y'.repeat(32) }).host).toBe('0.0.0.0');
  });

  it('defaults to loopback, mock data and SQLite', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.marketProvider).toBe('mock');
    expect(c.databaseUrl).toMatch(/^sqlite:/);
  });

  it('validates numeric settings', () => {
    expect(() => loadConfig({ PAPER_STARTING_BALANCE_SOL: '-5' })).toThrow();
    expect(() => loadConfig({ PAPER_TRADING_FEE_BPS: '5000' })).toThrow();
    expect(() => loadConfig({ MARKET_PROVIDER: 'binance' })).toThrow();
  });
});

describe('db helpers', () => {
  it('converts placeholders and redacts credentials', () => {
    expect(toPgPlaceholders('a = ? AND b = ?')).toBe('a = $1 AND b = $2');
    expect(redactDbUrl('postgres://user:secret@host:5432/db')).toBe('postgres://user:***@host:5432/db');
  });
});

/**
 * Static guard: the codebase must not contain transaction-signing or wallet code.
 * (scripts/verify-no-real-trading.mjs performs the same scan across the repo.)
 */
describe('no real-trading code paths', () => {
  const FORBIDDEN = [
    /@solana\/web3\.js/,
    /@solana\/kit/,
    /@coral-xyz\/anchor/,
    /\bsendTransaction\b/,
    /\bsendRawTransaction\b/,
    /\bsignTransaction\b/,
    /\bKeypair\b/,
    /\bfromSecretKey\b/,
    /\bbs58\b/,
    /pumpportal\.fun\/api\/trade/,
  ];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
    });

  it('src contains no signing / wallet / swap execution code', () => {
    const roots = [join(__dirname, '../src'), join(__dirname, '../../../packages/shared/src'), join(__dirname, '../../web/src')];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const text = readFileSync(file, 'utf8');
        for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${file}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no dependency on Solana signing libraries', () => {
    for (const pkg of ['../package.json', '../../web/package.json', '../../../packages/shared/package.json', '../../../package.json']) {
      const json = readFileSync(join(__dirname, pkg), 'utf8');
      expect(json).not.toMatch(/@solana\/|anchor|bs58|tweetnacl/);
    }
  });
});
