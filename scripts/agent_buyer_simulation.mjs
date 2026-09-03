import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

const API_BASE = process.env.EVAL_API_BASE
  ? `${process.env.EVAL_API_BASE}/api/agent/v1`
  : 'http://localhost:3001/api/agent/v1';
// NOTE: the buyer is a FOREIGN agent — no app account, no cookies. Any JWT whose
// signature matches the server's JWT_SECRET is accepted as a distinct buyer
// identity (the invoice is booked in the merchant's books, recipient = buyer).
// Settle without a bound mandate -> HTTP 402 + real Payment Link (graceful).

// Mint a test JWT token for the buyer agent
const token = jwt.sign(
  { id: 'agent-buyer-test', email: 'agent@commerce.copilot', role: 'buyer' },
  process.env.JWT_SECRET || 'wygeashjwtegyhdfjgktgsydhf',
  { expiresIn: '1h' }
);

async function fetchWithAuth(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers
  };
  
  const res = await fetch(url, { ...options, headers });
  if (!res.ok && res.status !== 402) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  
  // Return the raw response so we can check for 402
  return res;
}

async function run() {
  console.log("=== AI Buyer Agent Simulation (x402 Protocol) ===");

  // 1. Discover the Catalog
  console.log("\n1. Fetching Catalog...");
  const catalogRes = await fetchWithAuth(`${API_BASE}/catalog`);
  const catalog = await catalogRes.json();
  console.log(`Found ${catalog.items.length} products.`);
  
  const targetProduct = catalog.items[0];
  if (!targetProduct) {
    console.error("No products in catalog.");
    return;
  }
  console.log(`Targeting product: ${targetProduct.name} (SKU: ${targetProduct.sku}) at list price ₹${targetProduct.price}`);

  // 2. Request a Quote (Initiate x402 Handshake)
  console.log("\n2. Requesting Quote...");
  const quoteRes = await fetchWithAuth(`${API_BASE}/quote`, {
    method: 'POST',
    body: JSON.stringify({
      line_items: [
        {
          sku: targetProduct.sku,
          quantity: 2
        }
      ]
    })
  });

  if (quoteRes.status !== 402) {
    console.error(`Expected HTTP 402 Payment Required, got ${quoteRes.status}`);
    return;
  }

  const challenge = await quoteRes.json();
  const authHeader = quoteRes.headers.get('www-authenticate');
  
  console.log("Received 402 Challenge:");
  console.log(`  Header: Www-Authenticate: ${authHeader}`);
  console.log(`  Body:`, challenge);

  // 3. Complete the Challenge (Settle the Payment)
  console.log("\n3. Settling the challenge...");
  const settleRes = await fetchWithAuth(`${API_BASE}/settle`, {
    method: 'POST',
    body: JSON.stringify({
      invoice_id: challenge.invoice_id,
      order_id: challenge.order_id
    })
  });
  
  const settlement = await settleRes.json();
  console.log("Settlement Response:", settlement);
  
  if (settlement.success || settlement.error === 'payment_required') {
    console.log("✅ Success! Machine-to-machine transaction completed seamlessly via x402 (Escalated to human gracefully).");
  } else {
    console.error("❌ Settlement failed.");
  }
}

run().catch(console.error);
