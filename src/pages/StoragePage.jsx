import { db } from '@/services/db';

import { useQuery } from '@tanstack/react-query';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Database, ExternalLink, FileText, HardDrive, Link2 } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import { formatCurrency } from '@/lib/invoiceHelpers';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export default function StoragePage() {
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => db.entities.Invoice.list('-created_date', 100),
  });

  const storedInvoices = invoices.filter(inv => inv.cid);

  // HONEST SIZE: previously this was a fabricated constant (count * 2.4 KB).
  // We cannot know the real IPFS-file size from DB metadata alone (Lighthouse
  // returns a CID, not bytes). So we compute a real byte estimate from the
  // actual stored invoice content (the JSON we uploaded) and label it as an
  // estimate — never a fake exact number.
  const approximateBytes = storedInvoices.reduce((sum, inv) => {
    try {
      return sum + Buffer.byteLength(JSON.stringify(inv), 'utf8');
    } catch {
      return sum;
    }
  }, 0);
  // Round up to whole KB for display (approximate, honest).
  const approximateKB = Math.max(1, Math.ceil(approximateBytes / 1024));

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold">Decentralized Storage</h2>
        <p className="text-xs text-muted-foreground">Invoices stored on IPFS/Filecoin</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <Database className="w-5 h-5 mx-auto text-primary mb-1" />
            <p className="text-lg font-bold">{storedInvoices.length}</p>
            <p className="text-[10px] text-muted-foreground">Stored</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <HardDrive className="w-5 h-5 mx-auto text-accent mb-1" />
            <p className="text-lg font-bold">{storedInvoices.length ? `${approximateKB} KB*` : '—'}</p>
            <p className="text-[10px] text-muted-foreground">*Approx. size</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <Link2 className="w-5 h-5 mx-auto text-blue-500 mb-1" />
            <p className="text-lg font-bold">{storedInvoices.filter(i => i.tx_hash).length}</p>
            <p className="text-[10px] text-muted-foreground">Active Deals</p>
          </CardContent>
        </Card>
      </div>

      {/* Stored Invoice List */}
      <div className="space-y-2">
        {isLoading ? (
          Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)
        ) : storedInvoices.length === 0 ? (
          <div className="text-center py-16">
            <Database className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No invoices stored on IPFS yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Store an invoice from the detail page — exact IPFS size isn't shown (Lighthouse returns a CID, not bytes)</p>
          </div>
        ) : (
          storedInvoices.map(inv => (
            <RouterLink key={inv.id} to={`/invoice/${inv.id}`} className="block">
              <Card className="hover:border-primary/30 hover:shadow-sm transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center">
                        <FileText className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{inv.invoice_number}</p>
                        <p className="text-xs text-muted-foreground">{inv.recipient_name}</p>
                      </div>
                    </div>
                    <Badge className={cn("text-[10px]", inv.tx_hash ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700')}>
                      {inv.tx_hash ? 'Active Deal' : 'Stored'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-muted-foreground truncate max-w-[200px]">CID: {inv.cid?.slice(0, 20)}...</span>
                    <span className="font-medium">{formatCurrency(inv.grand_total, inv.currency)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <a
                      href={`https://gateway.lighthouse.storage/ipfs/${inv.cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-primary font-medium"
                      onClick={e => e.stopPropagation()}
                    >
                      View on IPFS <ExternalLink className="w-3 h-3" />
                    </a>
                    <span className="text-[10px] text-muted-foreground">
                      {inv.updated_date ? format(new Date(inv.updated_date), 'dd MMM yyyy') : ''}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </RouterLink>
          ))
        )}
      </div>
    </div>
  );
}
