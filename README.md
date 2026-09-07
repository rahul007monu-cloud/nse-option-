# 📈 NSE Option Chain Analyzer (LTP‑Calculator style)

A zero‑dependency Node.js web app that reads an NSE index option chain and turns it into a
**trader‑friendly, LTP‑Calculator style** dashboard:

- **Live chart** of spot price + a momentum‑score line (auto‑refresh every 5s)
- **Open Interest** and **OI change** per strike (fresh writing vs unwinding)
- **PCR** (by OI) and **intraday PCR** (by change‑in‑OI)
- **IV** per strike and full **Greeks** — **Delta, Gamma, Theta (per‑day decay), Vega** — computed with Black‑Scholes
- **Max Pain**, and **Support / Resistance** walls (highest Put‑OI / Call‑OI)
- A single **Momentum signal**: `Strong Bullish … Neutral … Strong Bearish`
  (🟢 green = UP, 🔴 red = DOWN) with a 0–100 strength and **plain‑language reasons**
- **Per‑strike verdict** — e.g. *"Put writing — Support (▲ UP)"* or *"Call writing — Resistance (▼ DOWN)"*

> The core read is exactly what LTP‑Calculator users watch:
> **fresh Put writing → support builds → price tends UP**, and
> **fresh Call writing → resistance builds → price tends DOWN.**

---

## 🚀 Run

No `npm install` needed — only Node.js built‑ins.

```bash
node server.js
# then open http://localhost:3000
```

Change the port:

```bash
PORT=8080 node server.js
```

---

## 🔌 API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness + Node version |
| `GET /api/symbols` | Supported instruments (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) |
| `GET /api/analysis?symbol=NIFTY&expiry=0&mock=1` | Full analysis (ATM, PCR, Max Pain, S/R, Greeks, momentum, per‑strike verdicts) + recent history |
| `GET /api/history?symbol=NIFTY` | Spot / PCR / momentum‑score time series (for charts) |

Query flags:
- `mock=1` → force the built‑in simulator (skip broker/live).
- `expiry=0..3` → pick one of the next weekly expiries.

---

## 📡 Data sources (auto fallback)

The data layer (`src/nse.js`) tries three sources in order and normalises them to one shape:

1. **Broker hook** *(recommended for production)* — register your own fetcher:

   ```js
   const nse = require('./src/nse');
   nse.setBrokerFetcher(async (symbol, expiry) => {
     // Call Zerodha / Fyers / Upstox / Angel / Dhan etc.
     // Return the normalised shape:
     return {
       source: 'broker', symbol, underlyingValue: 24800,
       timestamp: new Date().toISOString(), expiry,
       rows: [
         { strikePrice: 24800,
           CE: { openInterest, changeinOpenInterest, totalTradedVolume, impliedVolatility, lastPrice },
           PE: { openInterest, changeinOpenInterest, totalTradedVolume, impliedVolatility, lastPrice } },
         // ...
       ],
     };
   });
   ```

2. **Live NSE** — direct `https` fetch from `nseindia.com` with cookie priming.
   Works when you run this on **your own machine / VPS** with real outbound internet.
   NSE aggressively rate‑limits/blocks datacenter IPs, so a broker feed is more reliable.

3. **Mock simulator** — a realistic, *evolving* option chain so the whole app works
   out‑of‑the‑box with **no setup and no internet**. Spot random‑walks, OI builds up
   (puts below / calls above spot), IV has a smile, and LTPs are Black‑Scholes‑consistent.

> In restricted/sandbox networks only the **mock** source will succeed — that's expected.
> Toggle **Mock** off in the UI (or drop `mock=1`) to attempt broker/live first.

---

## 🧠 How the momentum signal works

Score is built (range −100…+100, +ve = UP) from:

1. **OI writing flow** (weighted toward ATM): Put writing (bullish) vs Call writing (bearish),
   plus Call unwinding (bullish) / Put unwinding (bearish).
2. **PCR level** — high PCR bullish, low PCR bearish.
3. **Intraday PCR** (change‑in‑OI based) — who is stronger *today*.
4. **Max Pain gravity** — price tends to drift toward max pain near expiry.

The score maps to 7 buckets from **Strong Bullish** to **Strong Bearish**, shown as a
colored arrow + strength bar, with the contributing reasons listed in plain language.

---

## 📁 Structure

```
server.js            HTTP server + API + in‑memory history
src/greeks.js        Black‑Scholes price + Greeks + IV solver
src/nse.js           Broker hook → live NSE → mock (normalised chain)
src/analysis.js      ATM, PCR, Max Pain, S/R, per‑strike verdict, momentum
public/index.html    UI markup
public/style.css     Dark trading‑desk theme
public/app.js        Fetch loop, canvas chart, table, 5s refresh
```

---

## ⚠️ Disclaimer

Educational tool only. The mock source is a **simulator**, not real market data.
Wire a real broker/live feed before using it for anything real. **Not investment advice.**
