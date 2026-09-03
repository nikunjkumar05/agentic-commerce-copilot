import React from 'react';
import { createRoot } from 'react-dom/client';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import InvoicePreview from '@/components/invoice/InvoicePreview';

export const generateInvoicePDF = (invoice) => {
  return new Promise((resolve, reject) => {
    try {
      // Create a hidden container for the invoice preview
      const container = document.createElement('div');
      container.style.position = 'absolute';
      container.style.top = '-9999px';
      container.style.left = '-9999px';
      // Force a nice desktop width so the layout doesn't squash
      container.style.width = '800px'; 
      container.style.backgroundColor = '#ffffff';
      document.body.appendChild(container);

      // Render the InvoicePreview component into the hidden container
      const root = createRoot(container);
      root.render(React.createElement(InvoicePreview, { invoice }));

      // Give React time to mount and images to load
      setTimeout(async () => {
        try {
          // html2canvas will render the DOM node to a canvas
          const canvas = await html2canvas(container, { 
            scale: 2, 
            useCORS: true, 
            backgroundColor: '#ffffff' 
          });
          
          const imgData = canvas.toDataURL('image/png');
          const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
          
          const pdfWidth = pdf.internal.pageSize.getWidth();
          const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
          
          pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
          pdf.save(`${invoice.invoice_number || 'invoice'}.pdf`);
          
          // Cleanup
          root.unmount();
          document.body.removeChild(container);
          resolve();
        } catch (e) {
          root.unmount();
          document.body.removeChild(container);
          reject(e);
        }
      }, 500); 
    } catch (err) {
      reject(err);
    }
  });
};
