import type { MarketObservation } from '@spb/shared';
import { MarketObservationSchema } from '@spb/shared';
import { MockMarketProvider } from '../market/mockProvider';
import type { Frame } from './engine';

const SYNTHETIC_STEP_MS = 5_000;
/** Fixed epoch so synthetic runs are reproducible regardless of wall-clock time. */
const SYNTHETIC_EPOCH = Date.UTC(2026, 0, 1);

/** Generate frames from the mock simulator using a virtual clock (fully deterministic). */
export async function syntheticFrames(seed: number, steps: number, tokenCount: number): Promise<Frame[]> {
  let now = SYNTHETIC_EPOCH;
  const provider = new MockMarketProvider({ seed, tokenCount, clock: () => now, warmupMinutes: 15 });
  const frames: Frame[] = [];
  for (let i = 0; i < steps; i++) {
    now += SYNTHETIC_STEP_MS;
    const { observations } = await provider.poll();
    const map = new Map<string, MarketObservation>();
    for (const raw of observations) {
      const parsed = MarketObservationSchema.safeParse(raw);
      if (parsed.success) map.set(parsed.data.mint, parsed.data);
    }
    frames.push({ ts: now, observations: map });
  }
  return frames;
}

/** Group recorded observations into time-bucketed frames (bucket = poll interval). */
export function framesFromObservations(obs: MarketObservation[], bucketMs = SYNTHETIC_STEP_MS): Frame[] {
  const buckets = new Map<number, Map<string, MarketObservation>>();
  for (const o of obs) {
    const key = Math.floor(o.observedAt / bucketMs) * bucketMs;
    const m = buckets.get(key) ?? new Map<string, MarketObservation>();
    m.set(o.mint, o);
    buckets.set(key, m);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, m]) => ({ ts: Math.max(...[...m.values()].map((o) => o.observedAt)), observations: m }));
}
