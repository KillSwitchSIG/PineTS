// SPDX-License-Identifier: AGPL-3.0-only
// strategy.risk.* edge cases measured on TradingView (Pine v6, BINANCE:BTCUSDT 1h, BATS:AAPL 1D):
//   - allow_entry_in(long): a short strategy.entry placed while long becomes a sell of the long's
//     size; when another exit closes the long before it fills, it still fills and opens a short of
//     that size (BTCUSDT 1h: sell stop 0.08051 at 62,350.87 after the long of 0.08051 was closed by
//     its exit on the previous bar; AAPL 1D: short 100 at 44.95).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close
const H = 3600e3;
const T0 = Date.UTC(2024, 0, 1, 20); // bar 4 opens at midnight UTC

async function run(decl: string, body: string, ohlc: Bar[], tf: '60' | 'D' = '60') {
    const step = tf === 'D' ? 24 * H : H;
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: T0 + i * step, closeTime: T0 + (i + 1) * step - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("risk", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', tf, bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const rows = (s: any) => s.closedtrades.map((t: any) => [t.entry_id, t.entry_bar_index, t.exit_id, t.exit_price, t.exit_bar_index]);
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];

describe('allow_entry_in(long)', () => {
    it('a short placed while long opens a short of the long size when the long was closed before it filled', async () => {
        const s = await run(
            '',
            `strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 95, qty = 2)
    strategy.exit("XL", "L", limit = 102)`,
            [flat(100), flat(100), [100, 102.5, 99.5, 101], [99, 99, 94, 94.5], flat(94.5)],
        );
        expect(rows(s)).toEqual([['L', 1, 'XL', 102, 2]]);
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_price, t.size])).toEqual([['SS', 95, -1]]);
    });

    it('a short placed while flat still opens nothing', async () => {
        const s = await run(
            '',
            `strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 95)`,
            [flat(100), flat(100), [99, 99, 94, 94.5], flat(94.5)],
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.position_size).toBe(0);
    });
});
