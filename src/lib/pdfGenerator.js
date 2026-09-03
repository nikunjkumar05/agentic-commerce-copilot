import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export const generateInvoicePDF = (invoice) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;

  // Header
  doc.setFontSize(22);
  doc.setTextColor(79, 70, 229); // Indigo 600
  doc.text('TAX INVOICE', 14, 22);

  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Invoice Number: ${invoice.invoice_number}`, 14, 32);
  doc.text(`Date: ${new Date(invoice.created_date).toLocaleDateString()}`, 14, 38);
  doc.text(`Status: ${invoice.status.toUpperCase()}`, 14, 44);

  // Merchant Details
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text('From:', 14, 60);
  doc.setFontSize(10);
  doc.text(invoice.institution_name || 'AgentPay Gateway', 14, 66);
  doc.text(invoice.institution_address || '', 14, 72);
  doc.text(`GST: ${invoice.gst_number || 'N/A'}`, 14, 78);

  // Buyer Details
  doc.setFontSize(12);
  doc.text('To:', 120, 60);
  doc.setFontSize(10);
  doc.text(invoice.recipient_name || 'AI Agent Buyer', 120, 66);
  doc.text(invoice.recipient_address || '', 120, 72);

  // Table
  const tableColumn = ["Description", "Quantity", "Unit Price", "Total"];
  const tableRows = [];

  const items = invoice.line_items || [];
  items.forEach(item => {
    const itemData = [
      item.description,
      item.quantity || 1,
      `Rs. ${item.unit_price?.toLocaleString('en-IN')}`,
      `Rs. ${item.total?.toLocaleString('en-IN')}`
    ];
    tableRows.push(itemData);
  });

  autoTable(doc, {
    startY: 90,
    head: [tableColumn],
    body: tableRows,
    theme: 'striped',
    headStyles: { fillColor: [79, 70, 229] },
  });

  const finalY = doc.lastAutoTable.finalY || 90;

  // Totals
  doc.setFontSize(10);
  doc.text('Subtotal:', 140, finalY + 10);
  doc.text(`Rs. ${invoice.subtotal?.toLocaleString('en-IN')}`, 170, finalY + 10);
  
  doc.text('Tax (18%):', 140, finalY + 18);
  doc.text(`Rs. ${invoice.tax_total?.toLocaleString('en-IN')}`, 170, finalY + 18);

  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.text('Grand Total:', 140, finalY + 28);
  doc.text(`Rs. ${invoice.grand_total?.toLocaleString('en-IN')}`, 170, finalY + 28);

  // Footer
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.setTextColor(150);
  doc.text('Thank you for your business!', 14, finalY + 45);
  if (invoice.tx_hash) {
    doc.text(`Transaction Ref: ${invoice.tx_hash}`, 14, finalY + 52);
  }

  doc.save(`${invoice.invoice_number}.pdf`);
};
