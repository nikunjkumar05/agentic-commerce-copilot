import 'dotenv/config';
import fetch from 'node-fetch';

const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET || ''}`).toString('base64');
fetch('https://api.razorpay.com/v1/customers', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ name: 'Agent', email: 'agent@test.com', contact: '9876543210' })
})
  .then(res => res.json())
  .then(console.log)
  .catch(console.error);

