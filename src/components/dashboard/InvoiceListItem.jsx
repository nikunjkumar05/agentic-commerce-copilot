import { Link } from 'react-router-dom';
import { ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { SmallStamp } from '@/components/Stamp';

const statusConfig = {
  draft: { label: 'Draft', className: 'text-muted-foreground bg-muted/80' },
  validated: { label: 'Validated', className: 'text-accent bg-accent/10' },
  stored: { label: 'On IPFS', className: 'text-success bg-success/10' },
  paid: { label: 'Paid', className: 'text-success bg-success/10' },
  anomaly: { label: 'Anomaly', className: 'text-destructive bg-destructive/10' },
};

function formatCurrency(amount, currency = 'INR') {
  if (currency === 'INR') return `₹${(amount || 0).toLocaleString('en-IN')}`;
  if (currency === 'USD') return `$${(amount || 0).toLocaleString('en-US')}`;
  if (currency === 'ETH') return `${amount} ETH`;
  return `${amount} ${currency}`;
}

export default function InvoiceListItem({ invoice }) {
  const status = statusConfig[invoice.status] || statusConfig.draft;

  return (
    <Link
      to={`/invoice/${invoice.id}`}
      className="paper-card-hover flex items-center gap-3 px-4 py-3.5 group"
    >
      <div className="relative w-11 h-11 shrink-0">
        <div className={cn(
          'w-11 h-11 rounded-xl flex items-center justify-center',
          invoice.status === 'paid' ? 'bg-success/10' : invoice.status === 'validated' ? 'bg-accent/10' : invoice.status === 'anomaly' ? 'bg-destructive/10' : 'bg-primary/8'
        )}>
          <FileText className={cn(
            'w-5 h-5',
            invoice.status === 'paid' ? 'text-success' : invoice.status === 'validated' ? 'text-accent' : invoice.status === 'anomaly' ? 'text-destructive' : 'text-primary'
          )} />
        </div>
        {(invoice.status === 'validated' || invoice.status === 'paid') && (
          <SmallStamp status={invoice.status} className="absolute -top-2 -right-2 w-6 h-6 opacity-70" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold truncate">{invoice.invoice_number}</p>
          <span className={cn(
            'text-[9px] px-1.5 py-0.5 rounded-full font-semibold tracking-wider uppercase',
            status.className
          )}>{status.label}</span>
        </div>
        <p className="text-xs text-muted-foreground truncate font-medium">{invoice.recipient_name}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
          {invoice.invoice_date ? format(new Date(invoice.invoice_date), 'dd MMM yyyy') :
            (invoice.created_date ? format(new Date(invoice.created_date), 'dd MMM yyyy') : '')}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold font-heading">{formatCurrency(invoice.grand_total, invoice.currency)}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-accent transition-colors shrink-0" />
    </Link>
  );
}
