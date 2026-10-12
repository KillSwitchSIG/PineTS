import { describe, it, expect } from 'vitest';
import { PineTS } from '../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

// Language constructs that diverged from TradingView. Each script plots the raw series it depends
// on, so the expected value on every bar is computed here by hand; the semantics were checked on
// TradingView with the same constructs (e.g. a rising edge through `(expr)[1]` fires on exactly
// the bars a rising edge through a variable does, inside `and`, `or` and `?:` alike).

async function run(body: string) {
    const src = `//@version=6
indicator("language parity")
${body}
plot(bar_index, "bi")
plot(close, "c")
plot(open, "o")`;
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-03').getTime());
    const { plots } = await pineTS.run(src);
    const times: number[] = plots['bi'].data.map((d: any) => d.time);
    expect(times.length).toBeGreaterThan(40);
    const series = (title: string): number[] => {
        expect(plots[title], `plot "${title}"`).toBeDefined();
        const byTime = new Map(plots[title].data.map((d: any) => [d.time, d.value]));
        return times.map((t) => (byTime.has(t) ? (byTime.get(t) as number) : NaN));
    };
    return { series, close: series('c'), open: series('o'), n: times.length };
}

describe('str.match', () => {
    it('returns the matched text, or "" when nothing matches', async () => {
        const { series } = await run(`
hit = str.match("abc{close[9]}def", "\\\\{\\\\w+\\\\[\\\\s*\\\\d+\\\\s*\\\\]\\\\}")
miss = str.match("abc", "z+")
plot(str.length(hit), "hitLen")
plot(miss == "" ? 1 : 0, "missEmpty")
plot(str.length(miss), "missLen")`);
        expect(series('hitLen').every((v) => v === 10)).toBe(true);
        expect(series('missEmpty').every((v) => v === 1)).toBe(true);
        expect(series('missLen').every((v) => v === 0)).toBe(true);
    });
});

describe('bool()', () => {
    it('is false for false', async () => {
        const { series } = await run(`
bool f = false
plot(bool(f) ? 1 : 0, "boolVar")
plot(bool(false) ? 1 : 0, "boolLit")
plot(bool(true) ? 1 : 0, "boolTrue")
plot(bool(0) ? 1 : 0, "boolZero")
plot(bool(1) ? 1 : 0, "boolOne")
plot(bool(na) ? 1 : 0, "boolNa")`);
        expect(series('boolVar').every((v) => v === 0)).toBe(true);
        expect(series('boolLit').every((v) => v === 0)).toBe(true);
        expect(series('boolTrue').every((v) => v === 1)).toBe(true);
        expect(series('boolZero').every((v) => v === 0)).toBe(true);
        expect(series('boolOne').every((v) => v === 1)).toBe(true);
        expect(series('boolNa').every((v) => v === 0)).toBe(true);
    });
});
