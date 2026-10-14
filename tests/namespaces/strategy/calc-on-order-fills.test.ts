// SPDX-License-Identifier: AGPL-3.0-only
// strategy(calc_on_order_fills = true) as on TradingView (BINANCE:BTCUSDT 1h, Pine v6, probes
// "cof01"–"cof07" and controlled case "25"). On a historical bar the broker walks the path open →
// nearer extreme → farther extreme → close; a fill between two points belongs to the later one.
// After the points with fills (other than the close) the script runs again, on the complete bar,
// with the broker state at that point: its market orders fill at that point's price, its limit /
// stop orders work on the rest of the path. `var` is rolled back between the runs of a bar; plots
// come from the bar's last run.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("cof", default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 5, margin_long = 0, margin_short = 0${decl})
${body}`;
    return new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
}
const COF = ', calc_on_order_fills = true';
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];
const entries = (s: any) => [...s.closedtrades, ...s.opentrades].map((t: any) => [t.entry_id, t.entry_price, t.entry_bar_index]);

describe('calc_on_order_fills', () => {
    it('after a fill at the open, a market order placed by the script fills at that open on the same bar', async () => {
        const body = `if bar_index == 0
    strategy.entry("E", strategy.long)
if strategy.position_size > 0 and strategy.opentrades == 1
    strategy.order("O", strategy.long)`;
        const bars: Bar[] = [flat(), [101, 101.2, 99, 100], flat(), flat()];
        expect(entries((await run(COF, body, bars)).strategy)).toEqual([['E', 101, 1], ['O', 101, 1]]);
        // without the setting the order waits for the next bar
        expect(entries((await run('', body, bars)).strategy)).toEqual([['E', 101, 1], ['O', 100, 2]]);
    });

    it('after a limit fill inside a segment, a close fills at the point ending that segment', async () => {
        // bar 1: open 100, high 100.2 first, then down to 98 (the buy limit at 99 fills on the way),
        // close 98.5: the close placed after the fill fills at the low, 98
        const s = (
            await run(
                COF,
                `if bar_index == 0
    strategy.entry("E", strategy.long, limit = 99)
if strategy.position_size > 0
    strategy.close("E")`,
                [flat(), [100, 100.2, 98, 98.5], flat(98.5)],
            )
        ).strategy!;
        expect(s.closedtrades.map((t: any) => [t.entry_price, t.exit_price, t.exit_bar_index])).toEqual([[99, 98, 1]]);
    });

    it('a limit placed after a fill and not reached on the rest of the bar stays pending', async () => {
        // the entry fills at bar 1's open (100); the limit at 97 placed then is not reached on bar 1
        // (low 98.5) and fills on bar 2
        const s = (
            await run(
                COF,
                `if bar_index == 0
    strategy.entry("E", strategy.long)
if strategy.position_size > 0 and strategy.opentrades == 1
    strategy.order("O", strategy.long, limit = 97)`,
                [flat(), [100, 100.4, 98.5, 99], [99, 99.2, 96.5, 97.5], flat(97.5)],
            )
        ).strategy!;
        expect(entries(s)).toEqual([['E', 100, 1], ['O', 97, 2]]);
    });

    it('var is rolled back between the runs of a bar and plots come from its last run', async () => {
        const ctx = await run(
            COF,
            `var int n = 0
n += 1
plot(n, "n")
if bar_index % 2 == 0
    strategy.entry("E", strategy.long)
if bar_index % 2 == 1
    strategy.close_all()`,
            [flat(), flat(101), flat(102), flat(103), flat(104), flat(105)],
        );
        expect((ctx.plots['n'].data as any[]).map((p) => p.value)).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe('strategy.order', () => {
    it('an order with the id of a pending order from an earlier bar modifies it', async () => {
        const s = (
            await run(
                '',
                `strategy.order("O", strategy.long, limit = 95)`,
                [flat(), flat(), flat(), [100, 100.2, 94, 95]],
            )
        ).strategy!;
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_price])).toEqual([['O', 95]]);
    });

    it('limit / stop levels snap to the tick grid away from the market', async () => {
        const s = (
            await run(
                '',
                `if bar_index == 0
    strategy.order("O", strategy.long, limit = 99.123)`,
                [flat(), [100, 100.2, 99, 99.5], flat()],
            )
        ).strategy!;
        expect(s.opentrades.map((t: any) => t.entry_price)).toEqual([99.12]);
    });
});
