import assert from 'node:assert';
import { scoreCatalog, buildJsonLd, suggestLiableParty } from '../api/gaps.js';

// #1: empty catalog scores 0 with guidance (no crash)
const e = scoreCatalog([]);
assert.equal(e.score, 0);
assert.ok(e.questions.length > 0);

// #1: clean product scores 100, messy one lower with fixes
const good = { id: 'a', sku: 'sku_a', name: 'Enterprise License', description: 'Annual license with 3-day shipping and 7-day returns.', price: 5000, margin_floor: 4000, hsn_code: '998313' };
const bad = { id: 'b', sku: null, name: 'Priya मिश्रित Mix', description: 'short', price: -5, margin_floor: 99, hsn_code: null };
const r = scoreCatalog([good, bad]);
assert.equal(r.product_count, 2);
assert.ok(r.score < 100 && r.score > 0);
assert.equal(r.issues.length, 1);
assert.equal(r.issues[0].sku, null);

// #1: JSON-LD is schema.org shaped
const ld = buildJsonLd([good]);
assert.equal(ld['@context'], 'https://schema.org');
assert.equal(ld.itemListElement[0].item.offers.priceCurrency, 'INR');

// #5: misinterpretation suggests seller_agent; clean gate suggests none
assert.equal(suggestLiableParty({ instruction: 'buy medium pizza 12 inch', interpretation: 'bought 8 inch', action_taken: 'paid' }), 'seller_agent');
assert.equal(suggestLiableParty({ instruction: 'pay if under cap', interpretation: 'pay if under cap', action_taken: 'blocked: over cap, escalated' }), 'none');

console.log('gaps_check: OK (score, jsonld, liability heuristics)');
