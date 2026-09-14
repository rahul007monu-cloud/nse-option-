'use strict';

/**
 * plans.js — subscription plans + feature/limit definitions.
 *
 * These are the DEFAULTS seeded into the store. Admin can edit/add/remove plans
 * at runtime from the admin panel (stored in store.json).
 *
 * Feature keys used for gating across the app:
 *   'chain'    -> option chain analysis
 *   'greeks'   -> Greeks / Theta / IV
 *   'dema'     -> DEMA support/resistance
 *   'scanner'  -> the multi-room scanner
 *   'alerts'   -> (future) alerts
 *   'live'     -> live/broker data (vs mock)
 */

function defaultPlans() {
  return [
    {
      id: 'free',
      name: 'Free',
      price: 0,
      currency: 'INR',
      period: 'forever',
      tagline: 'Get started',
      // No payment gateway is wired yet (the pricing page says as much), so
      // gating features behind paid tiers only locks users — and the owner —
      // out of a product nobody can pay to upgrade. Until payments exist, Free
      // includes everything. To re-introduce tiers later, trim this list and
      // assign paid plans from the admin panel.
      features: ['chain', 'greeks', 'dema', 'scanner', 'live'],
      limits: { symbols: 'all F&O', refreshSec: 5 },
      highlights: ['Index option chain', 'PCR, Max Pain', 'Greeks & Theta', 'Mock/demo data'],
      active: true,
      order: 1,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: 499,
      currency: 'INR',
      period: 'month',
      tagline: 'For active traders',
      features: ['chain', 'greeks', 'dema', 'scanner'],
      limits: { symbols: 'all F&O', refreshSec: 5 },
      highlights: ['Everything in Free', 'All F&O stocks', 'DEMA support/resistance', 'Daily Scanner (all rooms)', 'SL / Target / R:R'],
      active: true,
      badge: 'Popular',
      order: 2,
    },
    {
      id: 'premium',
      name: 'Premium',
      price: 999,
      currency: 'INR',
      period: 'month',
      tagline: 'Full power + live data',
      features: ['chain', 'greeks', 'dema', 'scanner', 'alerts', 'live'],
      limits: { symbols: 'all F&O', refreshSec: 3 },
      highlights: ['Everything in Pro', 'Live broker data ready', 'Priority scanner', 'Alerts (coming soon)'],
      active: true,
      order: 3,
    },
  ];
}

/** Does a plan (by id) include a feature? */
function planHasFeature(plan, feature) {
  if (!plan) return false;
  return Array.isArray(plan.features) && plan.features.includes(feature);
}

module.exports = { defaultPlans, planHasFeature };
