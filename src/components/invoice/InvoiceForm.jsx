import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';

export default function InvoiceForm({ invoice, onChange }) {
  const update = (field, value) => {
    onChange({ ...invoice, [field]: value });
  };

  const updateLineItem = (index, field, value) => {
    const items = [...(invoice.line_items || [])];
    items[index] = { ...items[index], [field]: value };
    if (field === 'quantity' || field === 'unit_price' || field === 'tax_rate') {
      const qty = field === 'quantity' ? Number(value) : Number(items[index].quantity || 0);
      const price = field === 'unit_price' ? Number(value) : Number(items[index].unit_price || 0);
      const tax = field === 'tax_rate' ? Number(value) : Number(items[index].tax_rate || 18);
      const base = qty * price;
      items[index].total = base + (base * tax / 100);
    }
    const subtotal = items.reduce((sum, it) => sum + ((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)), 0);
    const taxTotal = items.reduce((sum, it) => {
      const base = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
      return sum + (base * (Number(it.tax_rate) || 18) / 100);
    }, 0);
    onChange({ ...invoice, line_items: items, subtotal, tax_total: taxTotal, grand_total: subtotal + taxTotal });
  };

  const addLineItem = () => {
    const items = [...(invoice.line_items || []), { description: '', quantity: 1, unit_price: 0, tax_rate: 18, total: 0 }];
    onChange({ ...invoice, line_items: items });
  };

  const removeLineItem = (index) => {
    const items = (invoice.line_items || []).filter((_, i) => i !== index);
    const subtotal = items.reduce((s, it) => s + ((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)), 0);
    const taxTotal = items.reduce((s, it) => {
      const base = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
      return s + (base * (Number(it.tax_rate) || 18) / 100);
    }, 0);
    onChange({ ...invoice, line_items: items, subtotal, tax_total: taxTotal, grand_total: subtotal + taxTotal });
  };

  return (
    <div className="space-y-5 p-4">
      {/* Institution Details */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-bold uppercase text-muted-foreground tracking-widest font-heading">From (Institution)</h3>
        <div className="rule" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs font-medium">Institution Name</Label>
            <Input value={invoice.institution_name || ''} onChange={e => update('institution_name', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
          </div>
          <div>
            <Label className="text-xs font-medium">GST Number</Label>
            <Input value={invoice.gst_number || ''} onChange={e => update('gst_number', e.target.value)} className="mt-1 h-9 text-sm font-mono bg-white" placeholder="07AAACN0372J1ZB" />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs font-medium">Address</Label>
            <Input value={invoice.institution_address || ''} onChange={e => update('institution_address', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
          </div>
        </div>
      </div>

      {/* Recipient Details */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-bold uppercase text-muted-foreground tracking-widest font-heading">To (Recipient)</h3>
        <div className="rule" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs font-medium">Recipient Name</Label>
            <Input value={invoice.recipient_name || ''} onChange={e => update('recipient_name', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
          </div>
          <div>
            <Label className="text-xs font-medium">Recipient GST</Label>
            <Input value={invoice.recipient_gst || ''} onChange={e => update('recipient_gst', e.target.value)} className="mt-1 h-9 text-sm font-mono bg-white" />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs font-medium">Recipient Address</Label>
            <Input value={invoice.recipient_address || ''} onChange={e => update('recipient_address', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
          </div>
        </div>
      </div>

      {/* Invoice Meta */}
      <div className="rule" />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs font-medium">Invoice Date</Label>
          <Input type="date" value={invoice.invoice_date || ''} onChange={e => update('invoice_date', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
        </div>
        <div>
          <Label className="text-xs font-medium">Due Date</Label>
          <Input type="date" value={invoice.due_date || ''} onChange={e => update('due_date', e.target.value)} className="mt-1 h-9 text-sm bg-white" />
        </div>
        <div>
          <Label className="text-xs font-medium">Currency</Label>
          <Select value={invoice.currency || 'INR'} onValueChange={v => update('currency', v)}>
            <SelectTrigger className="mt-1 h-9 text-sm bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="INR">₹ INR</SelectItem>
              <SelectItem value="USD">$ USD</SelectItem>
              <SelectItem value="ETH">ETH</SelectItem>
              <SelectItem value="USDC">USDC</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Line Items */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase text-muted-foreground tracking-widest font-heading">Line Items</h3>
          <Button variant="outline" size="sm" onClick={addLineItem} className="h-7 text-xs gap-1 border-muted-foreground/20">
            <Plus className="w-3 h-3" /> Add Item
          </Button>
        </div>
        {(invoice.line_items || []).map((item, idx) => (
          <div key={idx} className="bg-muted/40 rounded-2xl p-3.5 space-y-2.5 border border-border/60">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground font-mono">Item {idx + 1}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-destructive/10" onClick={() => removeLineItem(idx)}>
                <Trash2 className="w-3 h-3 text-destructive" />
              </Button>
            </div>
            <Input placeholder="Item description" value={item.description || ''} onChange={e => updateLineItem(idx, 'description', e.target.value)} className="h-8 text-sm bg-white" />
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[10px] text-muted-foreground">Qty</Label>
                <Input type="number" value={item.quantity || ''} onChange={e => updateLineItem(idx, 'quantity', e.target.value)} className="h-8 text-sm bg-white" />
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Unit Price</Label>
                <Input type="number" value={item.unit_price || ''} onChange={e => updateLineItem(idx, 'unit_price', e.target.value)} className="h-8 text-sm bg-white" />
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Tax %</Label>
                <Input type="number" value={item.tax_rate ?? 18} onChange={e => updateLineItem(idx, 'tax_rate', e.target.value)} className="h-8 text-sm bg-white" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="paper-card p-4 bg-accent/[0.02] border-accent/10">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-medium">₹{(invoice.subtotal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="rule my-2" />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Tax (GST @ 18%)</span>
          <span className="font-medium">₹{(invoice.tax_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="rule-gold my-2" />
        <div className="flex justify-between text-base">
          <span className="font-bold font-heading">Grand Total</span>
          <span className="font-bold font-heading text-accent">₹{(invoice.grand_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
        </div>
      </div>
    </div>
  );
}
