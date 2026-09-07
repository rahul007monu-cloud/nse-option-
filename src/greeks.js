'use strict';

/**
 * greeks.js
 * -----------------------------------------------------------------------------
 * Black-Scholes option pricing + Greeks (Delta, Gamma, Theta, Vega, Rho) and a
 * Newton-Raphson implied-volatility solver.
 *
 * Everything here is pure math — no dependencies. Volatility (sigma) and rate
 * (r) are given as decimals (e.g. 0.18 = 18% IV, 0.065 = 6.5% risk-free rate).
 * Time to expiry T is in YEARS.
 *
 * Theta is returned as **per-day** decay (annual theta / 365) because that is
 * what an options trader actually watches ("aaj kitna theta lag raha hai").
 * Vega is returned per **1% (0.01)** change in IV — the trader-friendly unit.
 * -----------------------------------------------------------------------------
 */

// Standard normal probability density function
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Standard normal cumulative distribution (Abramowitz & Stegun 7.1.26)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  let p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

function d1d2(S, K, T, r, sigma, q = 0) {
  const vt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt;
  const d2 = d1 - vt;
  return { d1, d2 };
}

/**
 * Theoretical Black-Scholes price.
 * type: 'CE' (call) or 'PE' (put)
 */
function bsPrice(type, S, K, T, r, sigma, q = 0) {
  if (T <= 0 || sigma <= 0) {
    // At/after expiry -> intrinsic value
    return type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  if (type === 'CE') {
    return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

/**
 * Full Greeks bundle for one option.
 * Returns { price, delta, gamma, theta (per day), vega (per 1% IV), rho }.
 */
function greeks(type, S, K, T, r, sigma, q = 0) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  const pdf = normPdf(d1);
  const sqrtT = Math.sqrt(T);
  const discR = Math.exp(-r * T);
  const discQ = Math.exp(-q * T);

  const gamma = (discQ * pdf) / (S * sigma * sqrtT);
  const vegaAnnual = S * discQ * pdf * sqrtT; // per 1.00 (100%) IV change

  let delta, thetaAnnual, rho;
  if (type === 'CE') {
    delta = discQ * normCdf(d1);
    thetaAnnual =
      -(S * discQ * pdf * sigma) / (2 * sqrtT) -
      r * K * discR * normCdf(d2) +
      q * S * discQ * normCdf(d1);
    rho = K * T * discR * normCdf(d2);
  } else {
    delta = discQ * (normCdf(d1) - 1);
    thetaAnnual =
      -(S * discQ * pdf * sigma) / (2 * sqrtT) +
      r * K * discR * normCdf(-d2) -
      q * S * discQ * normCdf(-d1);
    rho = -K * T * discR * normCdf(-d2);
  }

  return {
    price: bsPrice(type, S, K, T, r, sigma, q),
    delta: round(delta, 4),
    gamma: round(gamma, 6),
    theta: round(thetaAnnual / 365, 3), // per-day decay
    vega: round(vegaAnnual / 100, 3), // per 1% (0.01) IV move
    rho: round(rho / 100, 3),
  };
}

/**
 * Implied volatility from a market price via Newton-Raphson, with a bisection
 * fallback for stability. Returns sigma (decimal) or NaN if it can't converge.
 */
function impliedVol(type, marketPrice, S, K, T, r, q = 0) {
  if (marketPrice <= 0 || T <= 0) return NaN;

  const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice < intrinsic - 1e-6) return NaN;

  let sigma = 0.25; // initial guess
  for (let i = 0; i < 60; i++) {
    const price = bsPrice(type, S, K, T, r, sigma, q);
    const { d1 } = d1d2(S, K, T, r, sigma, q);
    const vega = S * Math.exp(-q * T) * normPdf(d1) * Math.sqrt(T); // per 1.00
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-5) return sigma;
    if (vega < 1e-8) break;
    sigma -= diff / vega;
    if (sigma <= 0 || sigma > 5 || !isFinite(sigma)) break;
  }

  // Bisection fallback
  let lo = 1e-4;
  let hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const price = bsPrice(type, S, K, T, r, mid, q);
    if (Math.abs(price - marketPrice) < 1e-5) return mid;
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function round(x, n) {
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

/** Convert calendar days -> years (365-day convention). */
function daysToYears(days) {
  return Math.max(days, 0) / 365;
}

module.exports = {
  normPdf,
  normCdf,
  bsPrice,
  greeks,
  impliedVol,
  daysToYears,
};
