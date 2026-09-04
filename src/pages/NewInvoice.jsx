import { db } from '@/services/db';

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { MessageSquare, FormInput, Save, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { generateInvoiceNumber } from '@/lib/invoiceHelpers';
import ChatInput from '@/components/invoice/ChatInput';
import AiThinking from '@/components/invoice/AiThinking';
import InvoiceForm from '@/components/invoice/InvoiceForm';

const emptyInvoice = {
  invoice_number: '',
  institution_name: '',
  institution_address: '',
  gst_number: '',
  recipient_name: '',
  recipient_address: '',
  recipient_gst: '',
  line_items: [],
  subtotal: 0,
  tax_total: 0,
  grand_total: 0,
  currency: 'INR',
  status: 'draft',
  invoice_date: new Date().toISOString().split('T')[0],
  ai_suggestions: [],
};

export default function NewInvoice() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState('chat');
  const savedProfile = (() => {
    try { return JSON.parse(localStorage.getItem('institution_profile') || '{}'); } catch { return {}; }
  })();

  const [invoice, setInvoice] = useState({
    ...emptyInvoice,
    invoice_number: generateInvoiceNumber(),
    institution_name: savedProfile.name || '',
    institution_address: savedProfile.address || '',
    gst_number: savedProfile.gst || '',
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isGenerating]);

  const saveMutation = useMutation({
    mutationFn: (data) => db.entities.Invoice.create(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success('Invoice saved as draft');
      navigate(`/invoice/${result.id}`);
    },
  });

  const handleChatSend = async (message) => {
    setChatMessages(prev => [...prev, { role: 'user', content: message }]);
    setIsGenerating(true);

    try {
      const result = await db.integrations.Core.InvokeLLM({
        prompt: `Generate a B2B commerce invoice from this request: "${message}"

Return ONLY a valid JSON object matching this exact schema:
{
  "institution_name": "string",
  "institution_address": "string",
  "gst_number": "string (15 chars, valid Indian GST format)",
  "recipient_name": "string",
  "recipient_address": "string",
  "recipient_gst": "string",
  "line_items": [{"description": "string", "quantity": number, "unit_price": number, "tax_rate": 18, "total": number}],
  "subtotal": number,
  "tax_total": number,
  "grand_total": number,
  "currency": "INR",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD",
  "ai_suggestions": [{"field": "string", "issue": "string", "suggestion": "string", "severity": "info|warning|error"}]
}

Rules:
- Default GST rate is 18% (CGST 9% + SGST 9%)
- Auto-calculate subtotal, tax_total, grand_total
- Generate realistic institution details if not provided
- Flag any compliance issues in ai_suggestions
- Use Indian numbering format
- If GST numbers are not provided, generate valid format ones and add info suggestion`,
        response_json_schema: {
          type: "object",
          properties: {
            institution_name: { type: "string" },
            institution_address: { type: "string" },
            gst_number: { type: "string" },
            recipient_name: { type: "string" },
            recipient_address: { type: "string" },
            recipient_gst: { type: "string" },
            line_items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  quantity: { type: "number" },
                  unit_price: { type: "number" },
                  tax_rate: { type: "number" },
                  total: { type: "number" }
                }
              }
            },
            subtotal: { type: "number" },
            tax_total: { type: "number" },
            grand_total: { type: "number" },
            currency: { type: "string" },
            invoice_date: { type: "string" },
            due_date: { type: "string" },
            ai_suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  issue: { type: "string" },
                  suggestion: { type: "string" },
                  severity: { type: "string" }
                }
              }
            }
          }
        }
      });

      if (!result || !result.line_items) {
        throw new Error('Invalid response from AI');
      }
      setIsDemoMode(!!result.demo_mode);

      const recalcSubtotal = result.line_items.reduce((sum, it) => sum + (Number(it.quantity ?? 0) * Number(it.unit_price ?? 0)), 0);
      const recalcTax = result.line_items.reduce((sum, it) => {
        const base = Number(it.quantity ?? 0) * Number(it.unit_price ?? 0);
        return sum + (base * (Number(it.tax_rate ?? 18)) / 100);
      }, 0);

      setInvoice(prev => ({
        ...prev,
        ...result,
        line_items: result.line_items.map(it => ({
          ...it,
          total: Number(it.quantity ?? 0) * Number(it.unit_price ?? 0),
        })),
        subtotal: recalcSubtotal,
        tax_total: recalcTax,
        grand_total: recalcSubtotal + recalcTax,
        invoice_number: prev.invoice_number,
        status: 'draft',
      }));

      setChatMessages(prev => [...prev, {
        role: 'ai',
        content: `Invoice generated for ${result.recipient_name || 'recipient'} — ₹${(recalcSubtotal + recalcTax).toLocaleString('en-IN')}. Review the form below and save when ready.`
      }]);
      setMode('form');
    } catch (err) {
      // FAIL LOUD: surface the actual reason (e.g. MISTRAL_API_KEY missing)
      // instead of a hidden, generic failure. No mocked data is injected here.
      console.error('Invoice generation failed:', err);
      const reason = err?.response?.data?.message || err?.message || 'Unknown error';
      toast.error(`Invoice generation unavailable: ${reason}`, { duration: 6000 });
      setChatMessages(prev => [...prev, {
        role: 'ai',
        content: `Sorry, the AI couldn't generate the invoice right now. ${reason}`
      }]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = () => {
    saveMutation.mutate(invoice);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-3">
        <Link to="/">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-muted/80">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-sm font-heading font-bold">New Invoice</h2>
          <p className="text-[10px] text-muted-foreground font-mono">{invoice.invoice_number}</p>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5 bg-accent hover:bg-accent/90 text-accent-foreground border-0" onClick={handleSave} disabled={saveMutation.isPending || !invoice.recipient_name}>
          <Save className="w-3.5 h-3.5" />
          Save
        </Button>
      </div>

      <div className="px-4">
        <div className="rule" />
      </div>

      {/* Mode Tabs */}
      <Tabs value={mode} onValueChange={setMode} className="flex-1 flex flex-col min-h-0">
        <div className="px-4 pt-2 pb-1">
          <TabsList className="w-full h-9 bg-muted/60 rounded-xl p-0.5">
            <TabsTrigger value="chat" className="text-xs flex-1 gap-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <MessageSquare className="w-3 h-3" /> Chat
            </TabsTrigger>
            <TabsTrigger value="form" className="text-xs flex-1 gap-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <FormInput className="w-3 h-3" /> Form
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="chat" className="flex-1 flex flex-col min-h-0 mt-0">
          <div className="flex-1 overflow-y-auto px-4 space-y-3 pb-2">
            <div className="flex items-start gap-3 pt-2">
              <div className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center overflow-hidden border border-border shrink-0">
                <img src="/logo.png" alt="AgentPay" className="w-full h-full object-cover" />
              </div>
              <div className="bg-muted/60 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[85%]">
                <p className="text-sm">Hi! I'm your AI Co-Pilot. Describe the invoice you need, and I'll generate it.</p>
                <p className="text-xs text-muted-foreground mt-2">Example: "Generate an invoice for ₹50,000 for IT services to Delhi Municipal Corporation"</p>
              </div>
            </div>

            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                {msg.role === 'ai' && (
                  <div className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center overflow-hidden border border-border shrink-0">
                    <img src="/logo.png" alt="AgentPay" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className={`rounded-2xl px-4 py-3 max-w-[85%] text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-tr-sm'
                    : 'bg-muted/60 rounded-tl-sm'
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}

            {isGenerating && <AiThinking />}
            <div ref={chatEndRef} />
          </div>
          <ChatInput onSend={handleChatSend} isLoading={isGenerating} placeholder="Describe your invoice..." />
        </TabsContent>

        <TabsContent value="form" className="flex-1 overflow-y-auto mt-0">
          <InvoiceForm invoice={invoice} onChange={setInvoice} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
