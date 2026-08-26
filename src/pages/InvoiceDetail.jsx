import { db } from '@/services/db';

import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { ArrowLeft, Printer, FileDown, Database, CreditCard, Pencil, ShieldCheck, Loader2, Trash2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import InvoicePreview from '@/components/invoice/InvoicePreview';
import InvoiceForm from '@/components/invoice/InvoiceForm';
import ValidationPanel from '@/components/invoice/ValidationPanel';
import { generateCID } from '@/lib/invoiceHelpers';
import { useRef } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import Stamp from '@/components/Stamp';

export default function InvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('preview');
  const [isEditing, setIsEditing] = useState(false);
  const [editedInvoice, setEditedInvoice] = useState(null);
  const [isStoring, setIsStoring] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const previewRef = useRef(null);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const list = await db.entities.Invoice.filter({ id });
      return list[0];
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data) => db.entities.Invoice.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success('Invoice updated');
      setIsEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => db.entities.Invoice.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success('Invoice deleted');
      navigate('/');
    },
  });

  const handleStoreOnIPFS = async () => {
    setIsStoring(true);
    try {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/ipfs/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(invoice)
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      const cid = data.cid;

      await db.entities.Invoice.update(id, { cid, status: 'stored' });
      queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      
      toast.success('Invoice stored on IPFS!', { 
        description: (
          <a href={data.gatewayUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-400">
            View CID: {cid.slice(0, 20)}...
          </a>
        )
      });
    } catch (err) {
      console.error(err);
      toast.error('Failed to store on IPFS');
    }
    setIsStoring(false);
  };

  const handleValidate = async () => {
    setIsValidating(true);
    const result = await db.integrations.Core.InvokeLLM({
      prompt: `Validate this government invoice for compliance: ${JSON.stringify(invoice)}. Check GST, calculations, missing fields, anomalies. Return score 0-100 and issues.`,
      response_json_schema: {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          score: { type: "number" },
          issues: { type: "array", items: { type: "object", properties: { field: { type: "string" }, severity: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" } } } }
        }
      }
    });
    await db.entities.Invoice.update(id, {
      compliance_score: result.score,
      ai_suggestions: result.issues || [],
      status: result.passed ? 'validated' : 'anomaly',
    });
    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    setIsValidating(false);
  };

  const handlePrint = () => window.print();

  const handleExportPDF = async () => {
    if (!previewRef.current) return;
    setIsExportingPDF(true);
    const canvas = await html2canvas(previewRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    pdf.save(`${invoice.invoice_number}.pdf`);
    setIsExportingPDF(false);
    toast.success('PDF downloaded!');
  };

  const handleExportCSV = () => {
    if (!invoice?.line_items) return;
    const header = 'Description,Quantity,Unit Price,Tax Rate,Total\n';
    const rows = invoice.line_items.map(i => `"${i.description}",${i.quantity},${i.unit_price},${i.tax_rate},${i.total}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invoice.invoice_number}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <div className="p-4 space-y-3">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>;
  if (!invoice) return <div className="p-8 text-center text-muted-foreground">Invoice not found</div>;

  const displayInvoice = isEditing ? editedInvoice : invoice;

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-2">
        <Link to="/"><Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-muted/80"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-heading font-bold truncate">{invoice.invoice_number}</h2>
          <p className="text-[10px] text-muted-foreground font-medium">{invoice.recipient_name}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted/80" onClick={() => { setIsEditing(!isEditing); setEditedInvoice({ ...invoice }); }}>
          <Pencil className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-destructive/10" onClick={() => deleteMutation.mutate()}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      </div>

      {/* Status Stamp */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-2">
          {invoice.status === 'validated' && <Stamp text="VALIDATED" variant="gold" className="w-10 h-10" />}
          {invoice.status === 'paid' && <Stamp text="PAID" variant="green" className="w-10 h-10" />}
          {invoice.status === 'anomaly' && <Stamp text="ANOMALY" variant="red" className="w-10 h-10" />}
          {invoice.status === 'draft' && <Stamp text="DRAFT" variant="navy" className="w-10 h-10" />}
          <div className="text-[10px] text-muted-foreground font-mono">{invoice.status?.toUpperCase()}</div>
        </div>
      </div>

      <div className="px-4">
        <div className="rule" />
      </div>

      {/* Action Buttons */}
      <div className="px-4 py-2 flex gap-2 overflow-x-auto scrollbar-hide">
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0 border-muted-foreground/20" onClick={handlePrint}>
          <Printer className="w-3 h-3" /> Print
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0 border-muted-foreground/20" onClick={handleExportCSV}>
          <FileDown className="w-3 h-3" /> CSV
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0 border-muted-foreground/20" onClick={handleExportPDF} disabled={isExportingPDF}>
          {isExportingPDF ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />} PDF
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0 border-muted-foreground/20" onClick={handleValidate} disabled={isValidating}>
          {isValidating ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Validate
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0 border-muted-foreground/20" onClick={handleStoreOnIPFS} disabled={isStoring || !!invoice.cid}>
          {isStoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />}
          {invoice.cid ? 'On IPFS' : 'Store IPFS'}
        </Button>
        <Link to={`/invoice/${id}/pay`}>
          <Button size="sm" className="h-8 text-xs gap-1 shrink-0 bg-accent hover:bg-accent/90 text-accent-foreground border-0">
            <CreditCard className="w-3 h-3" /> Pay
          </Button>
        </Link>
      </div>

      {/* Content */}
      <div className="px-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full h-9 bg-muted/60 rounded-xl p-0.5 mb-3">
            <TabsTrigger value="preview" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Preview</TabsTrigger>
            <TabsTrigger value="edit" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Edit</TabsTrigger>
            <TabsTrigger value="review" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Compliance</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="mt-0">
            <div ref={previewRef}>
              <InvoicePreview invoice={displayInvoice} />
            </div>
          </TabsContent>

          <TabsContent value="edit" className="mt-0">
            <InvoiceForm invoice={editedInvoice || invoice} onChange={setEditedInvoice} />
            {editedInvoice && (
              <div className="px-4 pt-2">
                <Button className="w-full bg-accent hover:bg-accent/90 text-accent-foreground border-0" onClick={() => updateMutation.mutate(editedInvoice)} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Save Changes
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="review" className="mt-0">
            <ValidationPanel
              score={invoice.compliance_score}
              suggestions={invoice.ai_suggestions}
              isValidating={isValidating}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
