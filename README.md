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
- **Whole NSE F&O universe** — all indices **and** F&O stocks (~300 instruments), with a searchable picker
- **Daily EMA (DEMA) levels** — 10 / 20 / 50 / 100 / 200 DEMA shown as **support** (below price) or **resistance** (above price), plus an EMA‑stack **trend** read that feeds the momentum score

> **Scope:** Option chains exist only for **F&O** securities (indices + the NSE F&O stock list),
> not for cash‑only stocks. "DEMA" here means **Daily EMA** (the daily‑timeframe EMA).

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

## 🟢 Use it LIVE (real NSE data)

The app tries **live NSE** by default (untick the **Mock** box in the UI). Whether
you actually get live data depends on **where you run it**:

### Option A — Your own PC/laptop (easiest, free) ✅
NSE allows normal residential IPs. Just run the server on your machine:

```bash
node server.js          # then open http://localhost:3000  (Mock box UNticked)
```

**Confirm it works (do this before market open):**

```bash
node scripts/live-check.js NIFTY
# ✅ LIVE DATA OK  -> you're set
# ⚠️ Fell back to MOCK -> your network/host is blocked (use Option B/C)
```

NSE indices/stocks trade **Mon–Fri, 09:15–15:30 IST**. Outside these hours the
app shows a **MARKET CLOSED** badge and freezes the last snapshot.

### Option B — Broker feed (real‑time from ANY host, incl. Vercel) ⭐
Most reliable. Use your broker's API (Zerodha/Fyers/Upstox/Angel/Dhan):

```bash
cp brokers/example-adapter.js brokers/zerodha.js   # implement fetchChain()
BROKER_MODULE=./brokers/zerodha.js node server.js
```

Keep API keys in env vars. See `brokers/example-adapter.js` for the exact shape.

### Option C — Vercel
Vercel's servers use datacenter IPs that **NSE blocks (HTTP 403)**, so direct live
NSE won't work there — it falls back to mock. For real data on Vercel, use a
**broker adapter (Option B)** with your token set as a Vercel Environment Variable,
or set `PREFER_MOCK=1` to keep it on the simulator intentionally.

> **Why not just "turn it on"?** There is no hosted key that gives free real‑time
> NSE data from the cloud. Real data comes either from **your own IP** (Option A)
> or **your authenticated broker** (Option B).

---

## ⚙️ Admin panel (enter your API keys)

Open **`/admin.html`**. Enter your Angel One SmartAPI credentials — **API Key,
Client Code, MPIN, TOTP Secret** — and hit **Save**, then **Test Connection**.
The server auto-generates the TOTP from your secret (no SMS / no authenticator
app needed at runtime) and turns the live source on.

- **Self-host (PC):** saved to `data/credentials.json` (gitignored) — persists.
- **Vercel:** file save is **temporary** (serverless). For permanent live data set
  `SMARTAPI_KEY / SMARTAPI_CLIENT / SMARTAPI_PIN / SMARTAPI_TOTP_SECRET` as
  Environment Variables (the panel shows the exact block), plus `ADMIN_TOKEN` to
  protect the panel.

Endpoints: `GET /api/admin/status`, `POST /api/admin/save|test|clear`
(protected by `x-admin-token` when `ADMIN_TOKEN` is set).

---

## 🛰️ Scanner (daily rooms)

Open **`/scanner.html`** (or the "Scanner" button on the main page). It scans the
whole F&O universe and sorts instruments into rooms, each with **SL / Target /
R:R** and a heuristic **possibility %**:

- 🟢 **At Support / Bounce** — price on a support DEMA / option support, bullish setup
- 📏 **On 20 DEMA** — price hugging the 20‑day EMA
- 📈 **Bullish** / 📉 **Bearish** — strong momentum either way
- ✨ **Golden Cross** — 50/200 (or 20/50) EMA crossover recently
- 🚀 **Breakout** — price clearing the 20‑day range (momentum‑confirmed)

`GET /api/scan?mock=1` returns the raw scan. Results are cached ~60s.

> This is a transparent **rule‑based** engine (OI + momentum + DEMA + crossover +
> breakout), not a self‑learning AI. SL/TP come from real technical levels; the
> possibility % is a confidence heuristic, **not a guaranteed probability**.

---

## ▲ Deploy on Vercel

This repo works on Vercel **without a build step**:

- `public/` is served as static (the UI) at the root.
- `api/*.js` run as serverless functions (`/api/health`, `/api/symbols`, `/api/analysis`).
- `server.js` is only for local / self-hosted runs — Vercel ignores it.

**Recommended Vercel project settings** (Project → Settings → Build & Development):

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Build Command | *(leave empty / Override OFF)* |
| Output Directory | *(leave empty / Override OFF)* |
| Root Directory | repo root (`./`) |
| Install Command | *(default)* |

Then just **Deploy**. `vercel.json` already handles routing (`/` → `index.html`) and API headers.

> **Why the page was blank before:** `server.js` is a long‑running Node HTTP
> server, but Vercel is **serverless** — it never runs `node server.js`. The API
> now lives in `api/*.js` (serverless) and the UI is static in `public/`, which
> is the shape Vercel expects. The chart history is accumulated in the browser
> (serverless instances keep no state).

> **Live data note:** Vercel's servers cannot reach `nseindia.com` reliably
> (datacenter IPs get blocked), so on Vercel the app runs on the **mock**
> simulator by default. For real‑time data, wire a broker feed via
> `setBrokerFetcher()` / `setHistoryFetcher()` (see below) or self‑host `server.js`.

---

## 🔌 API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness + Node version |
| `GET /api/symbols` | Full F&O universe grouped as `{ indices, stocks, total }` |
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

   // Optional: daily candles for the DEMA levels (oldest -> newest closes)
   nse.setHistoryFetcher(async (symbol) => [/* ...daily close prices... */]);
   ```

2. **Live NSE** — direct `https` fetch from `nseindia.com` with cookie priming.
   Indices use `/api/option-chain-indices`, stocks use `/api/option-chain-equities`.
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
data/symbols.js      NSE F&O universe (indices + F&O stocks + ref prices)
src/greeks.js        Black‑Scholes price + Greeks + IV solver
src/nse.js           Broker/live/mock chain + daily history (for DEMA) + symbol config
src/technicals.js    Daily EMA (10/20/50/100/200 DEMA) support/resistance + trend
src/analysis.js      ATM, PCR, Max Pain, S/R, per‑strike verdict, momentum, DEMA
public/index.html    UI markup
public/style.css     Dark trading‑desk theme
public/app.js        Fetch loop, canvas chart, table, DEMA panel, 5s refresh
```

---

## ⚠️ Disclaimer

Educational tool only. The mock source is a **simulator**, not real market data.
Wire a real broker/live feed before using it for anything real. **Not investment advice.**
