# Gold Scalp Bot — Spec from 48h Live Analysis

## The Fable

157 gold trades in 48h on your live account. 50.3% win rate — a coin flip with zero directional edge.
Net result: −A$197.59. Every trade cost you −A$1.26 in expectancy.

The killer: losses are 1.3× bigger than wins (A$10.48 vs A$7.84). At a 50% WR that's a slow bleed.
The silver bullet: **13 of 19 active hours lost money**. The bot is pumping trades through hours that statistically destroy capital.

Only 5 hours were profitable. Trading ONLY those hours flips the 48h from −A$198 to approximately +A$139.

## Concrete Rules from Data

### 1. Hour Gate (the biggest edge)
- **Tradeable (AWST):** 23:00 (+A$37, 64% WR), 00:00 (+A$34, 83% WR), 08:00 (+A$32, 43% WR but good RR), 19:00 (+A$8, 50% WR)
- **UTC equivalents:** 15, 16, 0, 11
- **Kill ALL others:** [1-10, 12-14, 17-23] UTC

### 2. Fix the RR Asymmetry
- Current: avg win +A$7.84, avg loss −A$10.48 (RR 0.75×)
- Target SL: A$8.00 (tighter than current A$10.48 avg loss)
- Target TP: A$10.00 (above current A$7.84 avg win)
- This flips RR to 1.25× — NOW the coin-flip WR of 50% is positive expectancy

### 3. Circuit Breakers
- **maxConsecutiveLosses: 4** — worst streak was 6 at −A$108. Halt sooner.
- **dailyLossCap: A$80** — below the A$108 worst streak, stops the bleeding day
- **maxHoldMin: 15** — gold moves fast; stale scalps die faster than oil or BTC

### 4. Single-Scalp Discipline
- maxOpenTrades: 1 (no stacking — one position, win or lose)
- cooldownSec: 180 (3 min between entries — was ~1.8 min in data, throttle)
- closeOnFlip: true (opposite signal = close current, don't hedge)
- minConfidence: Moderate (ignore "Lean" signals)

### 5. Position Sizing
- 0.01 lots (minimum — GOLD is a ~A$44/pt instrument)
- Risk mode deferred until proven on fixed sizing

## Implementation

Add `gold` to `lib/instruments.js`:

```javascript
gold: {
    id: 'gold',
    label: 'Gold',
    fullLabel: 'Gold (XAU)',
    epic: 'GOLD',
    yahooDaily: 'GC=F',
    yahooIntraday: 'GC=F',
    tradesWeekends: false,
    features: 'generic',
    liveLocked: false,
    priceDp: 2,
    sizeUnit: 'contracts',
    sizeDecimals: 2,
    minSize: 0.01,
    botDefaults: {
        sizeMode: 'fixed',
        positionSize: 0.01,
        tpMode: 'usd',
        tpValue: 10.0,     // A$10 TP (> avg win A$7.84)
        slMode: 'usd',
        slValue: 8.0,      // A$8 SL (< avg loss A$10.48)
        maxOpenTrades: 1,
        cooldownSec: 180,
        minConfidence: 'Moderate',
        maxSpreadToTp: 0.15,
        dailyLossCap: 80,
        allowLive: false,
        runnerEnabled: false,
        maxHoldMin: 15,
        maxConsecutiveLosses: 4,
        closeOnFlip: true,
        // ONLY trade: 00, 11, 15, 16 UTC (= 08, 19, 23, 00 AWST)
        killHours: [1,2,3,4,5,6,7,8,9,10,12,13,14,17,18,19,20,21,22,23],
        volTarget: 1.0,
        minRecentVol: 0,
        maxRecentVol: 0,
        sizeMultLean: 0.5,
        sizeMultModerate: 1.0,
        sizeMultStrong: 1.5,
    },
    botStateFile: 'bot_state_gold',
    botEnvFile: 'bot_env_gold.txt',
    newsPack: null, // no news — pure price-action signal for now
}
```

Also update:
- `INSTRUMENT_IDS` (automatically derived)
- Add gold nav in server.js (or wherever instrument tabs are rendered)
- Wire the server's signal logic to handle a pure price-action signal for gold (no news LLM)