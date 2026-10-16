// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { Trade } from '../types';
import { openTradeList } from '../utils';

/**
 * Pine's `strategy.opentrades` mirrors strategy.closedtrades' dual-role
 * pattern — see that file's header for the rationale.
 *
 *   strategy.opentrades            → scalar count via valueOf
 *   strategy.opentrades.profit(0)  → per-trade unrealized P&L
 *   strategy.opentrades.capital_held → property (sum of held capital)
 */
export function opentrades(context: any) {
    return () => {
        // SNAPSHOT the open-trades list AT CALL TIME (see closedtrades.ts for
        // the rationale — per-bar plot values must capture per-bar state).
        const list: Trade[] = openTradeList(context);
        const at = (i: any): Trade | undefined => list[Number(i)];
        const currentPrice = (): number => {
            const md = context.marketData;
            if (Array.isArray(md) && context.idx >= 0 && context.idx < md.length) {
                return md[context.idx]?.close ?? NaN;
            }
            return NaN;
        };

        const result: any = {
            // Scalar for consumers that store or plot the value (Series.from, $.param).
            __value: list.length,
            valueOf() { return list.length; },
            toString() { return String(list.length); },
            [Symbol.toPrimitive]() { return list.length; },
        };

        // PointValue converts price-change × qty into account-currency dollars.
        // 1 for crypto/forex; can be >1 for futures (e.g. $50 per point on ES).
        const pointValue: number = context.pine?.syminfo?.pointvalue ?? 1;

        // Helper: hypothetical exit commission if the trade closed right now
        // at current price. TV's open-trade profit deducts BOTH the entry
        // commission (already charged on trade.commission) AND this
        // hypothetical exit commission, so profit reflects "what would I
        // realize if I closed at this price".
        const hypotheticalExitComm = (t: Trade, cp: number): number => {
            const cfg = context.strategy?.config;
            const type = cfg?.commission_type ?? 'percent';
            const value = cfg?.commission_value ?? 0;
            if (!value) return 0;
            const qty = Math.abs(t.size);
            switch (type) {
                // Notional = qty × price × pointValue, commission = value% of it.
                case 'percent':           return qty * cp * pointValue * (value / 100);
                case 'cash_per_contract': return qty * value;
                case 'cash_per_order':    return value;
                default: return 0;
            }
        };

        // Per-trade cost-basis denominator for the * _percent getters.
        // TV uses entry notional + entry commission (the trade's true cost
        // basis), not just notional — the formula in the Pine docs
        // ("entry_price × quantity") is imprecise. Notional includes pointValue.
        const costBasis = (t: Trade): number =>
            Math.abs(t.size) * t.entry_price * pointValue + (t.commission ?? 0);

        result.profit = (i: any) => {
            const t = at(i);
            if (!t) return NaN;
            const cp = currentPrice();
            if (!Number.isFinite(cp)) return NaN;
            const dir = Math.sign(t.size);
            const priceChange = dir === 1 ? cp - t.entry_price : t.entry_price - cp;
            return priceChange * Math.abs(t.size) * pointValue - (t.commission ?? 0) - hypotheticalExitComm(t, cp);
        };
        result.profit_percent = (i: any) => {
            const t = at(i);
            if (!t) return NaN;
            const p = result.profit(i);
            if (!Number.isFinite(p)) return NaN;
            const basis = costBasis(t);
            return basis > 0 ? (100 * p) / basis : NaN;
        };
        result.size = (i: any) => at(i)?.size ?? NaN;
        result.commission = (i: any) => at(i)?.commission ?? NaN;
        result.entry_price = (i: any) => at(i)?.entry_price ?? NaN;
        result.entry_bar_index = (i: any) => at(i)?.entry_bar_index ?? NaN;
        result.entry_id = (i: any) => at(i)?.entry_id ?? '';
        result.entry_comment = (i: any) => at(i)?.entry_comment ?? at(i)?.entry_id ?? '';
        result.entry_time = (i: any) => at(i)?.entry_time ?? NaN;
        result.max_drawdown = (i: any) => at(i)?.max_drawdown ?? 0;
        result.max_drawdown_percent = (i: any) => {
            const t = at(i);
            if (!t || !t.max_drawdown) return 0;
            const basis = costBasis(t);
            return basis > 0 ? (100 * t.max_drawdown) / basis : 0;
        };
        result.max_runup = (i: any) => at(i)?.max_runup ?? 0;
        result.max_runup_percent = (i: any) => {
            const t = at(i);
            if (!t || !t.max_runup) return 0;
            const basis = costBasis(t);
            return basis > 0 ? (100 * t.max_runup) / basis : 0;
        };

        // capital_held (a PROPERTY in Pine): the full notional of the open trades, Σ |size| × entry
        // price × point value, whatever the margin percentage; 0 when flat. `na` without a margin
        // model (margin 0, the v5 default). TradingView: 39,999.56 = 0.64828 × 61,701.06 at 20%
        // margin, 61,701.06 for 1 contract at the v6 default of 100%.
        const s = context.strategy;
        const marginLong  = s?.config?.margin_long  ?? 100;
        const marginShort = s?.config?.margin_short ?? 100;
        const dir = Math.sign(s?.position_size ?? 0);
        const noMargin = !s || (dir > 0 ? !(marginLong > 0) : dir < 0 ? !(marginShort > 0) : !(marginLong > 0) && !(marginShort > 0));
        if (noMargin) {
            result.capital_held = NaN;
        } else {
            let totalHeld = 0;
            for (const t of list) totalHeld += Math.abs(t.size) * t.entry_price * pointValue;
            result.capital_held = totalHeld;
        }

        return result;
    };
}
