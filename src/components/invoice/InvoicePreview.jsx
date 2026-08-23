import { Database } from 'lucide-react';
import { formatCurrency, numberToWords } from '@/lib/invoiceHelpers';
import { format } from 'date-fns';
import Stamp from '@/components/Stamp';

const statusStamp = {
  draft: { text: 'DRAFT', variant: 'navy' },
  validated: { text: 'VALIDATED', variant: 'gold' },
  stored: { text: 'STORED', variant: 'green' },
  paid: { text: 'PAID', variant: 'green' },
  anomaly: { text: 'ANOMALY', variant: 'red' },
};

export default function InvoicePreview({ invoice }) {
  const stampConfig = statusStamp[invoice.status] || statusStamp.draft;

  return (
    <div className="bg-white text-gray-900 rounded-2xl border border-border/80 overflow-hidden relative shadow-sm">
      {/* Header */}
      <div className="govt-header-gradient px-6 py-5 relative">
        <div className="flex items-start justify-between relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center border border-white/10">
              <img src="/seeta.jpeg" alt="" className="w-7 h-7 rounded-lg object-contain" />
            </div>
            <div>
              <h2 className="text-base font-heading font-bold text-white">{invoice.institution_name || 'Institution Name'}</h2>
              <p className="text-xs text-white/70 mt-0.5">{invoice.institution_address}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-lg font-heading font-bold tracking-tight text-white">TAX INVOICE</p>
            <p className="text-[10px] text-white/60 font-mono mt-0.5">{invoice.invoice_number}</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-5">
        {/* Invoice Meta */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Bill To</p>
            <p className="font-semibold mt-1 text-gray-800">{invoice.recipient_name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{invoice.recipient_address}</p>
            {invoice.recipient_gst && (
              <p className="text-[11px] font-mono text-gray-400 mt-1">GST: {invoice.recipient_gst}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Details</p>
            <p className="text-xs mt-1 text-gray-600">
              Date: {invoice.invoice_date ? format(new Date(invoice.invoice_date), 'dd MMM yyyy') : '—'}
            </p>
            <p className="text-xs text-gray-600">
              Due: {invoice.due_date ? format(new Date(invoice.due_date), 'dd MMM yyyy') : '—'}
            </p>
            {invoice.gst_number && (
              <p className="text-[11px] font-mono text-gray-400 mt-1">GST: {invoice.gst_number}</p>
            )}
          </div>
        </div>

        <div className="rule" />

        {/* Line Items Table */}
        <div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100">
                <th className="text-left py-2 pr-2 font-semibold">#</th>
                <th className="text-left py-2 pr-2 font-semibold">Description</th>
                <th className="text-right py-2 pr-2 font-semibold">Qty</th>
                <th className="text-right py-2 pr-2 font-semibold">Rate</th>
                <th className="text-right py-2 pr-2 font-semibold">Tax</th>
                <th className="text-right py-2 font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.line_items || []).map((item, i) => (
                <tr key={i} className="border-b border-gray-50">
                  <td className="py-2.5 pr-2 text-gray-300 font-mono">{String(i + 1).padStart(2, '0')}</td>
                  <td className="py-2.5 pr-2 font-medium text-gray-800">{item.description}</td>
                  <td className="py-2.5 pr-2 text-right text-gray-600">{item.quantity}</td>
                  <td className="py-2.5 pr-2 text-right text-gray-600 font-mono">{formatCurrency(item.unit_price, invoice.currency)}</td>
                  <td className="py-2.5 pr-2 text-right text-gray-500">{item.tax_rate || 18}%</td>
                  <td className="py-2.5 text-right font-medium text-gray-800 font-mono">{formatCurrency(item.total, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-64 space-y-1.5 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Subtotal</span>
              <span className="font-mono">{formatCurrency(invoice.subtotal, invoice.currency)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>CGST (9%)</span>
              <span className="font-mono">{formatCurrency((invoice.tax_total || 0) / 2, invoice.currency)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>SGST (9%)</span>
              <span className="font-mono">{formatCurrency((invoice.tax_total || 0) / 2, invoice.currency)}</span>
            </div>
            <div className="border-t-2 border-gray-200 pt-2 flex justify-between text-base">
              <span className="font-bold font-heading text-gray-800">Grand Total</span>
              <span className="font-bold font-heading text-gray-900 font-mono">{formatCurrency(invoice.grand_total, invoice.currency)}</span>
            </div>
          </div>
        </div>

        {/* Amount in Words */}
        <div className="bg-gray-50 rounded-xl p-3.5 border border-gray-100">
          <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Amount in Words</p>
          <p className="text-xs font-medium mt-1 text-gray-700 font-heading italic">{numberToWords(invoice.grand_total || 0)}</p>
        </div>

        {/* Stamp */}
        {invoice.status && (
          <div className="flex justify-end -mt-2">
            <Stamp text={stampConfig.text} variant={stampConfig.variant} className="w-20 h-20 opacity-70" animate />
          </div>
        )}

        {/* Footer Badges */}
        <div className="flex flex-wrap gap-2 pt-1">
          {invoice.cid && (
            <span className="text-[10px] font-mono text-gray-400 bg-gray-50 px-2 py-1 rounded-lg border border-gray-100 flex items-center gap-1">
              <Database className="w-3 h-3" /> CID: {invoice.cid?.slice(0, 12)}...
            </span>
          )}
          {invoice.tx_hash && (
            <span className="text-[10px] font-mono text-gray-400 bg-gray-50 px-2 py-1 rounded-lg border border-gray-100">
              TX: {invoice.tx_hash?.slice(0, 10)}...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
