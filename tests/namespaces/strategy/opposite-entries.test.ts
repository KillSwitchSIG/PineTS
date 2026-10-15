// SPDX-License-Identifier: AGPL-3.0-only
// Two opposite strategy.entry market orders queued on one bar, as on TradingView (BINANCE:BTCUSDT
// 1h, probes "o07" / "o09"): an entry sized to reverse the position the entries queued before it
// would open fills with its own quantity when those did not fill — a short of 2 rejected for
// margin, then a long of 1, gives a long of 1.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

async function run(body: string, capital: number) {
    const ohlc = [100, 100, 100, 100];
    const bars = ohlc.map((c, i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", initial_capital = ${capital}, default_qty_type = strategy.fixed, default_qty_value = 1)
${body}`;
    const s: any = (await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src))).strategy;
    return { position: s.position_size, open: s.opentrades.map((t: any) => t.entry_id), closed: s.closedtrades.length };
}

describe('opposite entries queued on one bar', () => {
    it('a long queued after a short rejected for margin fills with its own quantity', async () => {
        // capital 150 at a price of 100: the short of 2 (200) is rejected, the long of 1 fills
        const r = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, qty = 2)
    strategy.entry("L", strategy.long, qty = 1)`,
            150,
        );
        expect(r).toEqual({ position: 1, open: ['L'], closed: 0 });
    });

    it('a short queued after a long rejected for margin fills with its own quantity', async () => {
        const r = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
    strategy.entry("S", strategy.short, qty = 1)`,
            150,
        );
        expect(r).toEqual({ position: -1, open: ['S'], closed: 0 });
    });
});
