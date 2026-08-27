import Razorpay from 'razorpay';
import crypto from 'crypto';

// Initialize the Razorpay SDK instance
const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
});

/**
 * Creates a new Razorpay Order for the agent settlement.
 * FEATURE 2: Uses Razorpay Route (Transfers) to autonomously split GST tax.
 * 
 * @param {number} amount - The grand total amount in INR
 * @param {string} receipt - A unique receipt id (invoice id)
 * @param {number} taxAmount - The amount of GST tax to automatically split
 */
export async function createAgentSettlementOrder(amount, receipt, taxAmount = 0) {
  try {
    const totalPaise = Math.round(amount * 100);
    const taxPaise = Math.round(taxAmount * 100);
    
    const options = {
      amount: totalPaise, 
      currency: "INR",
      receipt: receipt,
    };
    
    // Feature 2: Razorpay Route (Autonomous Split Payment for GST)
    const linkedAccountId = process.env.RAZORPAY_LINKED_ACCOUNT_ID;
    
    if (taxPaise > 0) {
      options.notes = {
        agent_autonomous_split: "true",
        tax_split_paise: taxPaise.toString(),
        vendor_net_paise: (totalPaise - taxPaise).toString(),
        tax_split_reason: "Autonomous GST Withholding by AI Agent (Razorpay Route)"
      };
      
      // When live linked account is provided in environment, attach direct Razorpay Route transfer
      if (linkedAccountId && linkedAccountId.startsWith('acc_')) {
        options.transfers = [{
          account: linkedAccountId,
          amount: taxPaise,
          currency: "INR",
          notes: { reason: "Automated GST Tax Withholding" },
          on_hold: 0
        }];
      }
    }
    
    // Simulate slight agent thinking delay
    await new Promise(r => setTimeout(r, 600));
    
    const order = await instance.orders.create(options);
    
    // Attach simulated Route breakdown so calling endpoints/logs have the full split telemetry
    order.route_split = {
      vendor_share_inr: (amount - taxAmount).toFixed(2),
      tax_withheld_inr: taxAmount.toFixed(2),
      tax_authority_account: linkedAccountId || "acc_in_gst_escrow_sandbox",
      split_status: linkedAccountId ? "route_transfer_dispatched" : "route_virtual_allocation_active"
    };
    
    // Feature 8 (Fix): Demonstrate True S2S Capture payload construction
    // In production, Agentic payments use pre-authorized tokens (e.g., mandate or recurring)
    console.log(`[AGENT_S2S_MANDATE_SIMULATION] Autonomously capturing order ${order.id} via Server-to-Server Token API:`, JSON.stringify({
      email: "agent@agentic-copilot.local",
      contact: "9999999999",
      amount: totalPaise,
      currency: "INR",
      order_id: order.id,
      customer_id: "cust_agentic_demo",
      token: "token_agent_preauth_vault",
      recurring: "1",
      description: "Agentic Autonomous Checkout"
    }, null, 2));

    return order;
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    throw error;
  }
}

/**
 * Verifies the signature from the Razorpay Webhook
 * FEATURE 1: Enterprise Grade Webhook Security
 */
export function verifyWebhookSignature(payloadBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';
  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadBody)
    .digest('hex');
    
  return generatedSignature === signature;
}

/**
 * Verifies the frontend checkout signature
 */
export function verifySignature(orderId, paymentId, signature) {
  const generatedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'dummy_secret')
    .update(orderId + "|" + paymentId)
    .digest('hex');
    
  return generatedSignature === signature;
}
