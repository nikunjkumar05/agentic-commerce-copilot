// Generate invoice number
export function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const num = Math.floor(1000 + Math.random() * 9000);
  return `INV-${year}-${num}`;
}

// Format currency
export function formatCurrency(amount, currency = 'INR') {
  if (!amount && amount !== 0) return '—';
  if (currency === 'INR') return `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (currency === 'USD') return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (currency === 'ETH') return `${amount} ETH`;
  return `${amount} ${currency}`;
}

// Validate GST number
export function validateGST(gst) {
  if (!gst) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gst);
}

// Convert number to words (Indian system)
export function numberToWords(num) {
  if (num === 0) return 'Zero Rupees Only';
  
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  
  function convertHundreds(n) {
    let str = '';
    if (n >= 100) { str += ones[Math.floor(n / 100)] + ' Hundred '; n %= 100; }
    if (n >= 20) { str += tens[Math.floor(n / 10)] + ' '; n %= 10; }
    if (n > 0) str += ones[n] + ' ';
    return str.trim();
  }
  
  const intPart = Math.floor(num);
  const decPart = Math.round((num - intPart) * 100);
  let result = '';
  
  if (intPart >= 10000000) { result += convertHundreds(Math.floor(intPart / 10000000)) + ' Crore '; }
  const rem1 = intPart % 10000000;
  if (rem1 >= 100000) { result += convertHundreds(Math.floor(rem1 / 100000)) + ' Lakh '; }
  const rem2 = rem1 % 100000;
  if (rem2 >= 1000) { result += convertHundreds(Math.floor(rem2 / 1000)) + ' Thousand '; }
  const rem3 = rem2 % 1000;
  if (rem3 > 0) result += convertHundreds(rem3);
  
  result = result.trim() + ' Rupees';
  if (decPart > 0) {
    result += ' and ' + convertHundreds(decPart) + ' Paise';
  }
  result += ' Only';
  return result;
}

// NOTE: Fakes deliberately REMOVED from this file.
// generateCID() and generateTxHash() used to be here, returning random strings
// that LOOKED like IPFS CIDs / EVM tx hashes but were meaningless. Any real CID
// or tx hash must come from a REAL integration:
//   - IPFS CIDs   → Lighthouse Web3 upload response (/api/ipfs/upload)
//   - tx hashes   → Razorpay pay_... ids / verified NEON refund refs
// No component imports them anymore; if you ever need a placeholder, prefer an
// explicit empty string + an "unavailable" label over a fake-looking value.