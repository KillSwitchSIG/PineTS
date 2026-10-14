// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { Order } from '../types';
import { Series } from '../../../Series';
import { parseArgsForPineParams, extractCallsiteId } from '../../utils';
import { roundToMintick } from '../utils';

/**
 * Pine signature (21 named args):
 *   strategy.exit(id, from_entry, qty, qty_percent, profit, limit, loss,
 *                 stop, trail_price, trail_points, trail_offset, oca_name,
 *                 comment, comment_profit, comment_loss, comment_trailing,
 *                 alert_message, alert_profit, alert_loss, alert_trailing,
 *                 disable_alert) → void
 *
 * Behavior:
 *   Stores a conditional exit order on `state.pending_orders` with
 *   category='exit'. Each bar, `processExitOrders()` (in utils.ts) checks
 *   TP / SL / trailing-stop conditions against bar high/low against the
 *   matching open trades, and fires a market close at the trigger price
 *   when hit. Multiple exit legs on a single call are treated OCO — the
 *   first leg to trigger fires; the exit order is then removed.
 *
 *   `profit` and `loss` are in TICKS (units of syminfo.mintick). `limit`
 *   and `stop` are absolute prices. `trail_price` + `trail_offset` form an
 *   absolute-price trailing-stop arm/ride pair; `trail_points` +
 *   `trail_offset` form a ticks-from-entry arm/ride pair.
 */
const EXIT_SIGNATURES = [
    [
        'id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop',
        'trail_price', 'trail_points', 'trail_offset', 'oca_name', 'comment',
        'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message',
        'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert',
    ],
];
const EXIT_ARGS_TYPES = {
    id: 'string',
    from_entry: 'string',
    qty: 'series', qty_percent: 'series',
    profit: 'series', limit: 'series',
    loss: 'series', stop: 'series',
    trail_price: 'series', trail_points: 'series', trail_offset: 'series',
    oca_name: 'string',
    comment: 'string', comment_profit: 'string', comment_loss: 'string', comment_trailing: 'string',
    alert_message: 'string', alert_profit: 'string', alert_loss: 'string', alert_trailing: 'string',
    disable_alert: 'boolean',
};

export function exit(context: any) {
    return (...args: any[]) => {
        if (!context.strategy) {
            throw new Error('strategy.exit() called before strategy() declaration');
        }

        // Extract the transpiler-injected callsite ID BEFORE parsing args
        // (so parseArgsForPineParams doesn't see the sentinel). When the call
        // comes from non-transpiled JS, the sentinel is absent — fall back
        // to a per-bar synthetic counter so each "raw" call still gets a
        // stable id within the bar (the cadence check below is fuzzier in
        // that case but still works for the canonical patterns).
        let callsiteId = extractCallsiteId(args);
        if (callsiteId === undefined) {
            const s = context.strategy;
            if (s._exit_fallback_last_bar !== context.idx) {
                s._exit_fallback_counter = 0;
                s._exit_fallback_last_bar = context.idx;
            }
            callsiteId = `exit_raw_${s._exit_fallback_counter++}`;
        }

        const parsed = parseArgsForPineParams<any>(args, EXIT_SIGNATURES, EXIT_ARGS_TYPES);

        const extractValue = (val: any) => {
            if (val === undefined || val === null) return val;
            if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
            if (typeof val === 'function') return val();
            if (val instanceof Series) return val.get(0);
            if (Array.isArray(val)) return val[val.length - 1];
            if (typeof val === 'object' && val.get !== undefined) return val.get(0);
            return val;
        };

        const idValue          = extractValue(parsed.id);
        const fromEntry        = extractValue(parsed.from_entry);
        const qty              = extractValue(parsed.qty);
        const qtyPercent       = extractValue(parsed.qty_percent);
        // An na leg is absent: `limit = na` with `profit = ...` uses the profit leg.
        const isNaValue = (v: any) => (typeof v === 'number' && Number.isNaN(v)) || (typeof v === 'object' && v !== null && '__value' in v);
        const leg = (v: any) => (isNaValue(v) ? undefined : v);
        // Fractional tick counts (TradingView, mintick 0.01): `profit` / `loss` round to the next
        // whole tick away from the entry (30000.4 and 30000.6 → 30001), `trail_offset` truncates
        // (2000.4, 2000.5 and 2000.6 → 2000).
        const wholeAway = (v: any) => (typeof v === 'number' ? Math.ceil(v - 1e-9) : v);
        const wholeTrunc = (v: any) => (typeof v === 'number' ? Math.trunc(v + Math.sign(v) * 1e-9) : v);
        const profit           = wholeAway(leg(extractValue(parsed.profit)));
        const limitRaw         = leg(extractValue(parsed.limit));
        const loss             = wholeAway(leg(extractValue(parsed.loss)));
        const stopRaw          = leg(extractValue(parsed.stop));
        const trailPriceRaw    = leg(extractValue(parsed.trail_price));
        const trailPoints      = leg(extractValue(parsed.trail_points));
        const trailOffset      = wholeTrunc(leg(extractValue(parsed.trail_offset)));

        // Snap limit/stop/trail_price to the mintick grid AWAY from the
        // current bar's close (broker-emulator convention — see
        // roundToMintick in utils.ts). Already-aligned inputs (e.g. an
        // exact `position_avg_price + N`) round to themselves; arbitrary
        // multiplications like `close * 0.95` get the same adverse
        // rounding Pine applies at order placement.
        const mintick = context.pine?.syminfo?.mintick ?? 0;
        const currentClose = Series.from(context.data.close).get(0);
        const limit       = limitRaw      !== undefined ? roundToMintick(limitRaw,      currentClose, mintick) : undefined;
        const stop        = stopRaw       !== undefined ? roundToMintick(stopRaw,       currentClose, mintick) : undefined;
        const trailPrice  = trailPriceRaw !== undefined ? roundToMintick(trailPriceRaw, currentClose, mintick) : undefined;

        // Detect stale-attachment: when this exit is attached to a pending
        // entry that REVERSES the current position, the user's absolute
        // limit/stop values (computed from strategy.position_avg_price at
        // call time) reflect the OUTGOING position's avg, not the incoming
        // one. TV silently drops those legs; we mark the order here and
        // processExitOrders skips the absolute legs when the flag is set.
        const fromEntryId = fromEntry ?? '';
        const pendingEntry = fromEntryId
            ? context.strategy.pending_orders.find(
                  (o: Order) => o.category === 'entry' && o.id === fromEntryId && o.status === 'pending',
              )
            : context.strategy.pending_orders.find(
                  (o: Order) => o.category === 'entry' && o.status === 'pending',
              );
        const attachedAtReversal = !!pendingEntry?._isReversalEntry;
        // Whether a trade this exit covers is already open. Its levels are then taken as given
        // even when already breached (a sell stop above the market fills at the next open).
        const coversOpenTrade = context.strategy.opentrades.some((t: any) => !fromEntryId || t.entry_id === fromEntryId);

        // Cadence detection: persistent vs ephemeral capture.
        // If the user called strategy.exit at THIS exact call site on the
        // previous bar, the pattern is "every bar" (persistent — variable
        // is in main scope, value always defined). If the prior bar had
        // no call, the pattern is "sparse" (ephemeral — variable likely
        // scoped to an if-block, NA on non-trigger bars in TV). Used
        // below by processExitOrders to suppress the stale-reversal drop
        // for persistent-pattern exits, matching TV's actual behavior of
        // firing the captured value when the user keeps refreshing it.
        const history = context.strategy._exit_call_history as Map<string, number>;
        const lastBarForSite = history.get(callsiteId);
        const isPersistent = lastBarForSite !== undefined && lastBarForSite === context.idx - 1;
        history.set(callsiteId, context.idx);

        // Pine semantic: calling strategy.exit with the same `id` REPLACES the
        // prior pending exit order (allowing dynamic TP/SL adjustment each
        // bar). Without this, stale exits accumulate across the strategy's
        // lifetime — they survive past their originating trade, and when a
        // later trade happens to satisfy the wrong-sided / stale-reversal
        // checks geometrically, the old order fires at a phantom price.
        // Same id + same from_entry scope is the replacement key.
        const exitId = idValue ?? 'exit';
        const list = context.strategy.pending_orders as Order[];
        const replaced: Order[] = [];
        for (let i = list.length - 1; i >= 0; i--) {
            const o = list[i];
            if (o.category === 'exit' && o.id === exitId && (o.from_entry ?? '') === fromEntryId && o.status === 'pending') {
                replaced.push(o);
                list.splice(i, 1);
            }
        }

        // With every price leg na the call places no order, and a re-call cancels the
        // pending exit it replaces (TradingView). It must not become a market close.
        if ([profit, limit, loss, stop, trailPrice, trailPoints].every((v) => v === undefined)) return;

        const order: Order = {
            id: exitId,
            direction: 0,           // resolved at trigger based on matching trades
            qty: qty !== undefined && !isNaValue(qty) ? Math.abs(Number(qty)) : 0,
            qty_percent: isNaValue(qtyPercent) ? undefined : qtyPercent,
            type: 'market',
            bar: context.idx,
            time: Series.from(context.data.openTime).get(0),
            status: 'pending',
            category: 'exit',
            from_entry: fromEntryId,
            profit, loss, limit, stop,
            trail_price: trailPrice,
            trail_points: trailPoints,
            trail_offset: trailOffset,
            oca_name: extractValue(parsed.oca_name),
            comment: extractValue(parsed.comment),
            comment_profit: extractValue(parsed.comment_profit),
            comment_loss: extractValue(parsed.comment_loss),
            comment_trailing: extractValue(parsed.comment_trailing),
            alert_message: extractValue(parsed.alert_message),
            alert_profit: extractValue(parsed.alert_profit),
            alert_loss: extractValue(parsed.alert_loss),
            alert_trailing: extractValue(parsed.alert_trailing),
            disable_alert: extractValue(parsed.disable_alert),
            _attachedAtReversal: attachedAtReversal,
            _coversOpenTrade: coversOpenTrade,
            _isPersistent: isPersistent,
            _callsiteId: callsiteId,
            // Was a position open when this exit was placed? Such an order belongs to THAT position and dies with it
            // (see processExitOrders); an exit placed while flat waits for its entry, as on TradingView.
            _placedWithPosition: context.strategy.opentrades.length > 0,
            _placedDir: Math.sign(context.strategy.position_size),
        };

        // Trail state carry-over: each trade's armed flag and running peak are
        // engine-accumulated state, not user parameters. When the user calls
        // strategy.exit every bar (the canonical "persistent" pattern), naive
        // replacement would reset them every bar, preventing the trail from
        // ever accumulating beyond a single bar's range. TV's trail state
        // persists across re-calls — only the user-tunable parameters
        // (trail_points, trail_offset, limit, stop, etc.) are refreshed.
        const trails = replaced.find((o) => o._trailByTrade);
        if (trails) order._trailByTrade = { ...trails._trailByTrade };
        // Placement order decides which exit's quantity is reserved first (see exitCapacity); a
        // re-call keeps the place of the exit it replaces.
        const strat = context.strategy as any;
        const seqs: Map<string, number> = (strat._exit_seqs ??= new Map());
        const seqKey = `${exitId}\u0000${fromEntryId}`;
        if (!seqs.has(seqKey)) seqs.set(seqKey, seqs.size + 1);
        order._seq = seqs.get(seqKey);
        list.push(order);
    };
}
