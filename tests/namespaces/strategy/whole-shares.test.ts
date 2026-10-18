import { describe, expect, it } from 'vitest';
import { Context } from '../../../src/Context.class';
import { PineTS } from '../../../src/PineTS.class';
import { calculateOrderQty, floorQty, initializeStrategy, partialCloseQty } from '../../../src/namespaces/strategy/utils';

/**
 * TradingView's broker emulator sizes stocks and funds in whole shares. When the provider
 * reports no syminfo.mincontract, the quantity step is 1 for syminfo.type stock / fund (a
 * computed or explicit qty is floored to whole shares); other types keep the 0.000001 step.
 * A reported mincontract is always the step.
 */
function makeContext(type: string, config: any = {}, mincontract?: number) {
    const context: any = new Context({ marketData: [], source: [], tickerId: 'X', timeframe: 'D' } as any);
    context.pine = { syminfo: { type, mintick: 0.01, pointvalue: 1, mincontract } } as any;
    initializeStrategy(context, { initial_capital: 10000, ...config });
    return context;
}

describe('Strategy - whole-share sizing', () => {
    it('percent_of_equity rounds down to whole shares for a stock', () => {
        const ctx = makeContext('stock', { default_qty_type: 'percent_of_equity', default_qty_value: 100 });
        expect(calculateOrderQty(ctx, undefined, 1, 300)).toBe(33); // 33.33…
    });

    it('cash and explicit qty round down for a fund', () => {
        const ctx = makeContext('fund', { default_qty_type: 'cash', default_qty_value: 1000 });
        expect(calculateOrderQty(ctx, undefined, 1, 70)).toBe(14); // 14.28…
        expect(calculateOrderQty(ctx, 7.9, 1, 70)).toBe(7);
    });

    it('float noise does not lose a share', () => {
        const ctx = makeContext('stock');
        expect(floorQty(ctx, 0.29 * 100)).toBe(29);
    });

    it('a qty_percent partial exit closes whole shares', () => {
        const ctx = makeContext('stock');
        expect(partialCloseQty(ctx, 33, 50)).toBe(16); // 16.5
    });

    it('crypto keeps the 6-decimal qty', () => {
        const ctx = makeContext('crypto', { default_qty_type: 'percent_of_equity', default_qty_value: 100 });
        expect(calculateOrderQty(ctx, undefined, 1, 300)).toBe(33.333333);
    });

    it("a stock's reported mincontract is the step", () => {
        const ctx = makeContext('stock', { default_qty_type: 'percent_of_equity', default_qty_value: 100 }, 0.01);
        expect(calculateOrderQty(ctx, undefined, 1, 300)).toBe(33.33);
    });

    it('an entry too small for one share places no order (custom provider, type stock)', async () => {
        const DAY = 86_400_000;
        const t0 = Date.UTC(2024, 0, 1);
        const candles = Array.from({ length: 10 }, (_, i) => ({
            openTime: t0 + i * DAY, closeTime: t0 + (i + 1) * DAY - 1,
            open: 500, high: 510, low: 490, close: 500, volume: 1000,
        }));
        const provider: any = {
            async getMarketData() { return candles; },
            async getSymbolInfo() {
                return { ticker: 'X', tickerid: 'X', prefix: '', root: 'X', description: 'X', type: 'stock',
                         timezone: 'UTC', session: '24x7', currency: 'USD', mintick: 0.01, pricescale: 100,
                         minmove: 1, pointvalue: 1 };
            },
        };
        const run = async (capital: number) => {
            const pineTS = new PineTS(provider, 'X', 'D', null, t0, t0 + 10 * DAY);
            const { plots } = await pineTS.run(`//@version=6
strategy("t", initial_capital = ${capital}, default_qty_type = strategy.percent_of_equity, default_qty_value = 100)
if bar_index == 1
    strategy.entry("L", strategy.long)
plot(strategy.position_size, "pos")
`);
            return plots['pos'].data.map((d: any) => d.value);
        };
        expect(Math.max(...(await run(400)))).toBe(0); // 0.8 share: no order
        expect(Math.max(...(await run(1600)))).toBe(3); // 3.2 shares: 3
    });
});
