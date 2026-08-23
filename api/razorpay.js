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
    
    // If there is tax, the Agent autonomously uses Razorpay Route to split the payment
    if (taxPaise > 0) {
      options.transfers = [
        {
          account: "acc_GST_Gov_Account_Mock", // Mock linked account for the tax authority
          amount: taxPaise,
          currency: "INR",
          notes: {
            reason: "Autonomous GST Withholding by AI Agent",
            receipt: receipt
          },
          linked_account_notes: ["reason", "receipt"],
          on_hold: 0 // Instantly settle to the tax account
        }
      ];
    }
    
    // Simulate slight agent thinking delay
    await new Promise(r => setTimeout(r, 800));
    
    const order = await instance.orders.create(options);
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
