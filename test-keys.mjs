import 'dotenv/config';
import Razorpay from 'razorpay';

async function testKeys() {
  console.log('--- Testing API Keys ---');
  
  // 1. Test Mistral
  console.log('\nTesting Mistral API...');
  try {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: 'Say hello in one word' }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    console.log('? Mistral API Success! Response:', data.choices[0].message.content.trim());
  } catch (e) {
    console.error('? Mistral API Failed:', e.message);
  }

  // 2. Test Razorpay
  console.log('\nTesting Razorpay API...');
  try {
    const rzp = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    // Create a tiny 1 INR test order
    const order = await rzp.orders.create({ amount: 100, currency: 'INR', receipt: 'test_receipt_1' });
    console.log('? Razorpay API Success! Created Test Order ID:', order.id);
  } catch (e) {
    console.error('? Razorpay API Failed:', e.message || e);
  }
}

testKeys();
