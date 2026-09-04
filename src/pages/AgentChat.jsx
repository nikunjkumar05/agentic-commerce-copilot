import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Send, Package, FileText, CheckCircle, Shield, Loader2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/services/db';
import { generateInvoicePDF } from '@/lib/pdfGenerator';

export default function AgentChat() {
  const navigate = useNavigate();
  
  // 1. Initialize from LocalStorage for persistence
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem('agent_chat_history');
      if (saved) return JSON.parse(saved);
    } catch (e) { console.error('Failed to load chat history'); }
    
    return [{ 
      role: 'assistant', 
      content: 'Hello! I am your AgentPay Gateway. You can ask me to search the catalog, generate an invoice, or trigger a payment autonomously.' 
    }];
  });

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
const [fallbackMode, setFallbackMode] = useState(false);
  const [fallbackCatalog, setFallbackCatalog] = useState([]);
  const [fallbackSimulated, setFallbackSimulated] = useState(false);
  const [fallbackCart, setFallbackCart] = useState([]);
  const [fallbackQuery, setFallbackQuery] = useState('');

  // --- Phase 3: Resilient Fallback Cart (LLM down => manual checkout keeps the sale) ---
  // Cart items carry `sku` (static catalog id or DB sku) so invoices created here
  // resolve against the mandate allowlist and stay autonomously settlable.
  const fallbackAdd = (p) => setFallbackCart(prev => {
    const key = p.sku ?? p.id;
    const found = prev.find(i => (i.sku ?? i.id) === key);
    if (found) return prev.map(i => (i.sku ?? i.id) === key ? { ...i, quantity: i.quantity + 1 } : i);
    return [...prev, { id: p.id ?? p.sku, sku: p.sku ?? p.id, name: p.name, price: Number(p.price), quantity: 1 }];
  });
  const fallbackRemove = (id) => setFallbackCart(prev => prev.filter(i => i.id !== id));
  const fallbackQty = (id, delta) => setFallbackCart(prev =>
    prev.map(i => i.id === id ? { ...i, quantity: i.quantity + delta } : i).filter(i => i.quantity > 0)
  );

  const fallbackCheckout = async () => {
    if (fallbackCart.length === 0) { toast.error('Cart is empty'); return; }
    try {
      const subtotal = fallbackCart.reduce((s, i) => s + i.price * i.quantity, 0);
      const tax_total = Math.round(subtotal * 0.18);
      const grand_total = subtotal + tax_total;
      const line_items = fallbackCart.map(i => ({
        sku: i.sku,
        description: i.name,
        quantity: i.quantity,
        unit_price: i.price,
        tax_rate: 18,
        total: i.price * i.quantity
      }));
      let profile = {};
      let buyerProfile = { name: 'AI Agent Buyer', address: 'New Delhi, India' };
      try { profile = JSON.parse(localStorage.getItem('institution_profile') || '{}'); } catch {}
      try { buyerProfile = JSON.parse(localStorage.getItem('buyer_profile') || '{}'); } catch {}
      const newInvoice = await db.entities.Invoice.create({
        invoice_number: 'INV-' + Math.floor(Math.random() * 100000),
        institution_name: profile.name || 'AgentPay Gateway',
        institution_address: profile.address || 'New Delhi, India',
        gst_number: profile.gst || '07AAACN0372J1ZB',
        recipient_name: buyerProfile.name || 'AI Agent Buyer',
        recipient_address: buyerProfile.address || 'New Delhi, India',
        recipient_gst: '',
        line_items, subtotal, tax_total, grand_total,
        currency: 'INR',
        status: 'draft',
        invoice_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 30 * 86400000).toISOString(),
        compliance_score: null,
        is_ai_upsell: false
      });
      setLastInvoiceId(newInvoice.id);
      setFallbackCart([]);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Invoice ${newInvoice.invoice_number} created for ₹${grand_total.toLocaleString('en-IN')}. Note: this invoice needs human validation before I can settle it autonomously.`,
        uiType: 'invoice',
        uiData: { id: newInvoice.id, invoice_number: newInvoice.invoice_number }
      }]);
      toast.success('Invoice created via manual fallback checkout');
    } catch (e) {
      toast.error(e.message || 'Fallback checkout failed');
    }
  };

  const [lastInvoiceId, setLastInvoiceId] = useState(() => localStorage.getItem('agent_last_invoice_id') || null); 
  const chatEndRef = useRef(null);

  // Release a simulated LLM outage from inside the chat (merchant/jailed-buyer
  // recovery without navigating to the Audit Trail). Real outages (no API key)
  // have no flag to release, so the button only shows for simulated ones.
  const restoreAutonomousMode = async () => {
    try {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/ops/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ flag: 'llm_disabled', enabled: false })
      });
      if (!res.ok) throw new Error('Restore rejected');
      setFallbackMode(false);
      setFallbackSimulated(false);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Autonomous mode restored — the agent LLM is back. Ask me anything.' }]);
      toast.success('Autonomous mode restored');
    } catch (e) {
      toast.error(e.message || 'Could not restore autonomous mode');
    }
  };

  // 2. Save to LocalStorage whenever messages change
  useEffect(() => {
    localStorage.setItem('agent_chat_history', JSON.stringify(messages));
    
    // Sync to server for Merchant Transcripts
    let sessionId = localStorage.getItem('agent_chat_session_id');
    if (!sessionId) {
      sessionId = 'sess-' + Math.random().toString(36).substring(2, 15);
      localStorage.setItem('agent_chat_session_id', sessionId);
    }
    
    let buyerName = 'Anonymous Buyer';
    try {
      const p = JSON.parse(localStorage.getItem('buyer_profile'));
      if (p?.name) buyerName = p.name;
    } catch {}

    fetch('/api/chat/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(localStorage.getItem('app_access_token') && { Authorization: `Bearer ${localStorage.getItem('app_access_token')}` })
      },
      body: JSON.stringify({ session_id: sessionId, messages, buyer_name: buyerName })
    }).catch(e => console.error('Failed to sync chat:', e));
    
  }, [messages]);

  useEffect(() => {
    if (lastInvoiceId) localStorage.setItem('agent_last_invoice_id', lastInvoiceId);
  }, [lastInvoiceId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // 3. When user returns from payment page, check if invoice was settled
  useEffect(() => {
    if (!lastInvoiceId) return;
    
    // Check if we already notified via the standard widget OR the autonomous widget
    const alreadyNotified = messages.some(m => m.uiType === 'settlement_complete' || m.uiType === 'payment_done');
    if (alreadyNotified) return;

    db.entities.Invoice.filter({ id: lastInvoiceId }).then(list => {
      const inv = list[0];
      if (inv && inv.status === 'paid') {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Invoice ${inv.invoice_number || inv.id} has been settled successfully via Razorpay. Amount: ₹${(inv.grand_total || 0).toLocaleString('en-IN')}. The transaction is now recorded in the audit trail.`,
          uiType: 'settlement_complete',
          uiData: { id: inv.id, invoice_number: inv.invoice_number, amount: inv.grand_total }
        }]);
      }
    }).catch(() => {});
  }, [lastInvoiceId, messages.length]);

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!input.trim()) return;

    const userText = input;
    setInput('');
    
    const newMessages = [...messages, { role: 'user', content: userText }];
    setMessages(newMessages);
    setIsTyping(true);

    try {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` })
        },
        body: JSON.stringify({ 
          messages: newMessages.map(m => {
            const cleanMsg = { role: m.role, content: m.content || "" };
            if (m.name) cleanMsg.name = m.name;
            if (m.tool_call_id) cleanMsg.tool_call_id = m.tool_call_id;
            if (m.tool_calls) cleanMsg.tool_calls = m.tool_calls;
            return cleanMsg;
          }) 
        })
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        // Resilient fallback: if the LLM is down/misconfigured, the backend
        // returns fallback_mode:true + the catalog. Instead of blocking the
        // sale, we drop into a manual "Search & Add to Cart" UI in this chat.
        if (body && body.fallback_mode) {
          setFallbackMode(true);
          setFallbackCatalog(body.catalog || []);
          setFallbackSimulated(Boolean(body.simulated));
          // Don't spam a notice on every message while halted — one is enough.
          setMessages(prev => {
            if (prev.length > 0 && prev[prev.length - 1].fallbackNotice) return prev;
            return [...prev, {
              role: 'assistant',
              fallbackNotice: true,
              content: body.message || 'The agent LLM is unavailable. Manual catalog ordering is enabled below — pick products and pay to keep the sale moving.',
            }];
          });
          return;
        }
        // FAIL LOUD: surface the reason for a non-fallback error.
        let reason = `Server returned ${res.status}`;
        if (body?.message) reason = body.message;
        throw new Error(reason);
      }

      const data = body;

      // LLM recovered (or kill-switch released elsewhere) — hide fallback cart.
      setFallbackMode(false);
      setFallbackSimulated(false);
      
      // Crucial: Append the assistant's tool_call request to history so the next turn validates
      if (data.tool_calls || data.content) {
        setMessages(prev => [...prev, data]);
      }

      if (data.tool_calls && data.tool_calls.length > 0) {
        const hasUpsell = data.tool_calls.some(c => c.function.name === 'suggest_upsell_bundle');
        for (const call of data.tool_calls) {
          const args = JSON.parse(call.function.arguments || '{}');

          if (call.function.name === 'search_catalog') {
            try {
              const catRes = await fetch('/api/catalog');
              const catalog = await catRes.json();
              const queryStr = (args.query || '').toLowerCase();
              
              let results = catalog;
              if (queryStr && queryStr !== 'all') {
                const matches = catalog.filter(p => 
                  p.name.toLowerCase().includes(queryStr) || 
                  p.description.toLowerCase().includes(queryStr)
                );
                results = matches.length > 0 ? matches : catalog;
              }
              const contentText = `Here is what I found in the catalog for "${args.query}":\n` + 
                results.map(r => `- ${r.name} (₹${r.price})`).join('\n');

              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: contentText,
                uiType: 'catalog',
                uiData: { results }
              }]);
            } catch (e) {
              setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'Sorry, I failed to load the catalog.' }]);
            }
          } else if (call.function.name === 'suggest_upsell_bundle') {
            try {
              const catRes = await fetch('/api/catalog');
              const catalog = await catRes.json();

              // The LLM now does the actual reasoning (the catalog is injected in
              // the system prompt) and returns recommended_item + reason. We only
              // resolve the recommendation against the catalog for real pricing.
              const originalItem = (args.original_item || '').toLowerCase();
              let recommendation = null;

              if (args.recommended_item) {
                recommendation = catalog.find(p =>
                  p.name.toLowerCase() === args.recommended_item.toLowerCase()
                ) || catalog.find(p =>
                  p.name.toLowerCase().includes(args.recommended_item.toLowerCase())
                );
              }
              // Graceful fallback: if the LLM didn't supply a valid recommendation
              // we use the catalog's pre-defined bundle mapping (machine-readable,
              // deterministic) instead of a random pick that erodes merchant trust.
              if (!recommendation && Array.isArray(catalog)) {
                const lowerCatalog = catalog.map(p => ({ ...p, nameLower: (p.name || '').toLowerCase() }));
                const anchor = lowerCatalog.find(p => originalItem.includes(p.nameLower));
                if (anchor?.machine_tags) {
                  const tagSet = new Set(anchor.machine_tags);
                  // Prefer a product in a DIFFERENT category but with overlap
                  recommendation = lowerCatalog.find(p =>
                    p.id !== anchor.id &&
                    p.machine_tags?.some(t => tagSet.has(t))
                  ) || null;
                }
                if (!recommendation) {
                  // Last resort: the catalog's first bundle, if it pairs with the anchor
                  const bundles = (await fetch('/.well-known/agent-catalog.json').then(r => r.json()).catch(() => null))?.bundles || [];
                  const matchingBundle = bundles.find(b => b.items?.some(id => id === anchor?.id));
                  if (matchingBundle) {
                    const partnerId = matchingBundle.items.find(id => id !== anchor?.id);
                    recommendation = lowerCatalog.find(p => p.id === partnerId) || null;
                  }
                }
                if (!recommendation) recommendation = lowerCatalog[0];
              }
              const reason = args.reason || 'It pairs well with your purchase and avoids gaps in coverage.';

              const toolResponse = `Recommended: ${recommendation.name} (₹${recommendation.price}) — ${reason}`;

              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'suggest_upsell_bundle',
                content: toolResponse
              }]);

              // Funnel tracking: this suggestion was shown to the buyer
              try {
                await db.entities.AgentAuditLog.create({
                  action: 'upsell_suggested',
                  details: `Agent suggested ${recommendation.name} (₹${recommendation.price}) for ${args.original_item}: ${reason}`
                });
              } catch { /* funnel logging must never break the chat */ }

              // No simulated follow-up turn: the recommendation is already shown
              // above as this tool's result. A real orchestrator (when wired in)
              // will drive the next step through the backend, not a client timer.

            } catch (e) {
              setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: 'suggest_upsell_bundle', content: 'I tried to find a bundle, but the catalog is currently unreachable.' }]);
            }
          }

          else if (call.function.name === 'create_invoice') {
            if (hasUpsell) {
              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'create_invoice',
                content: 'Invoice creation aborted. You must wait for the user to accept or decline the upsell bundle before creating the invoice.'
              }]);
              continue;
            }
            
            let profile = {};
            let buyerProfile = { name: 'AI Agent Buyer', address: 'New Delhi, India' };
            try { profile = JSON.parse(localStorage.getItem('institution_profile') || '{}'); } catch {}
            try { buyerProfile = JSON.parse(localStorage.getItem('buyer_profile') || '{}'); } catch {}
            
            const today = new Date().toISOString();
            const due = new Date(Date.now() + 30 * 86400000).toISOString();
            
            // Handle backwards compatibility if LLM uses old schema occasionally
            const itemsList = args.line_items || [{ description: args.description || 'Custom Item', amount: args.amount || 0 }];
            
            let subtotal = 0;
            let tax_total = 0;
            const taxRate = 18;
            
            let catalogList = [];
            try {
              const cr = await fetch('/api/catalog');
              catalogList = await cr.json();
            } catch {}

            const line_items = itemsList.map(item => {
              const matchedProd = Array.isArray(catalogList) ? catalogList.find(c => c.sku === item.sku || c.id === item.sku || (c.name && item.description && c.name.toLowerCase() === item.description.toLowerCase())) : null;
              const defaultListPrice = Number(matchedProd?.price || 0);
              const hasNegPrice = item.negotiated_price !== undefined && item.negotiated_price !== null;
              const baseAmount = hasNegPrice
                ? Number(item.negotiated_price)
                : (Number(item.amount || item.unit_price || item.price || 0) || defaultListPrice);
              const qty = Number(item.quantity || 1);
              const tax = Math.round(baseAmount * qty * taxRate / 100);
              const totalAmount = baseAmount * qty;
              subtotal += totalAmount;
              tax_total += tax;
              return {
                sku: item.sku,
                description: item.description || matchedProd?.name || item.sku,
                quantity: qty,
                ...(hasNegPrice ? { negotiated_price: Number(item.negotiated_price) } : {}),
                unit_price: baseAmount,
                tax_rate: taxRate,
                total: totalAmount
              };
            });
            
            const grand_total = subtotal + tax_total;
            const itemNames = line_items.map(i => i.sku || i.description).join(' + ');

            try {
              const newInvoice = await db.entities.Invoice.create({
                invoice_number: 'INV-' + Math.floor(Math.random() * 100000),
                institution_name: profile.name || 'AgentPay Gateway',
                institution_address: profile.address || 'New Delhi, India',
                gst_number: profile.gst || '07AAACN0372J1ZB',
                recipient_name: buyerProfile.name || 'AI Agent Buyer',
                recipient_address: buyerProfile.address || 'New Delhi, India',
                recipient_gst: '',
                line_items: line_items,
                subtotal,
                tax_total,
                grand_total,
                currency: 'INR',
                status: 'draft',
                invoice_date: today,
                due_date: due,
                compliance_score: null,
                is_ai_upsell: args.is_ai_upsell || false
              });

              setLastInvoiceId(newInvoice.id);

              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'create_invoice',
                content: `I have generated invoice ${newInvoice.invoice_number} for ${itemNames} at ₹${subtotal}. ${args.is_ai_upsell ? 'Great choice on the bundle!' : ''} 🎯 Note: as an agent I cannot grade my own work - this invoice needs human validation before I am allowed to settle it autonomously.`,
                uiType: 'invoice',
                uiData: { id: newInvoice.id, invoice_number: newInvoice.invoice_number }
              }]);
            } catch (err) {
              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'create_invoice',
                content: `Failed to create invoice: ${err.message}. If this is a margin floor violation, you must negotiate a higher price.`
              }]);
            }
          }

          else if (call.function.name === 'update_invoice') {
            try {
              const targetId = args.invoice_id?.trim() || lastInvoiceId;
              const existing = await db.entities.Invoice.read(targetId);
              if (!existing) throw new Error('Invoice not found');
              
              const itemsList = args.line_items || [];
              let subtotal = 0;
              let tax_total = 0;
              const taxRate = 18;
              
              let catalogList = [];
              try {
                const cr = await fetch('/api/catalog');
                catalogList = await cr.json();
              } catch {}

              const line_items = itemsList.map(item => {
                const matchedProd = Array.isArray(catalogList) ? catalogList.find(c => c.sku === item.sku || c.id === item.sku || (c.name && item.description && c.name.toLowerCase() === item.description.toLowerCase())) : null;
                const defaultListPrice = Number(matchedProd?.price || 0);
                const hasNegPrice = item.negotiated_price !== undefined && item.negotiated_price !== null;
                const baseAmount = hasNegPrice
                  ? Number(item.negotiated_price)
                  : (Number(item.amount || item.unit_price || item.price || 0) || defaultListPrice);
                const qty = Number(item.quantity || 1);
                const tax = Math.round(baseAmount * qty * taxRate / 100);
                const totalAmount = baseAmount * qty;
                subtotal += totalAmount;
                tax_total += tax;
                return {
                  sku: item.sku,
                  description: item.description || matchedProd?.name || item.sku,
                  quantity: qty,
                  ...(hasNegPrice ? { negotiated_price: Number(item.negotiated_price) } : {}),
                  unit_price: baseAmount,
                  tax_rate: taxRate,
                  total: totalAmount
                };
              });
              
              const grand_total = subtotal + tax_total;
              const itemNames = line_items.map(i => i.description).join(' + ');

              await db.entities.Invoice.update(targetId, {
                line_items,
                subtotal,
                tax_total,
                grand_total
              });

              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'update_invoice',
                content: `I have updated invoice ${existing.invoice_number}. It now includes ${itemNames} for a total of ₹${subtotal}.`,
                uiType: 'invoice',
                uiData: { id: existing.id, invoice_number: existing.invoice_number }
              }]);
            } catch (err) {
              setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: 'update_invoice', content: `Failed to update invoice: ${err.message}. If this is a margin floor violation, you must negotiate a higher price.` }]);
            }
          }

          else if (call.function.name === 'cancel_invoice') {
            try {
              const targetId = args.invoice_id?.trim() || lastInvoiceId;
              if (targetId) {
                await db.entities.Invoice.delete(targetId);
                if (targetId === lastInvoiceId) setLastInvoiceId(null);
                setMessages(prev => [...prev, {
                  role: 'tool',
                  tool_call_id: call.id,
                  name: 'cancel_invoice',
                  content: `I have successfully cancelled and deleted that draft invoice. Let me know what else you need!`,
                }]);
              } else {
                setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: 'cancel_invoice', content: "I couldn't find a draft to cancel." }]);
              }
            } catch (err) {
              setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: 'cancel_invoice', content: `Failed to cancel invoice.` }]);
            }
          }

          else if (call.function.name === 'trigger_payment') {
            // Prefer the specific invoice requested by the LLM/user (either invoice_number like INV-123 or UUID).
            // Fall back to lastInvoiceId only if no explicit invoice_id was provided.
            const targetId = args.invoice_id?.trim() || lastInvoiceId;
            
            if (!targetId) {
              setMessages(prev => [...prev, { role: 'tool', tool_call_id: call.id, name: 'trigger_payment', content: "I don't have a specific invoice ID to pay right now." }]);
              continue;
            }

            // Ensure backend bounds are the single source of truth

            try {
              // --- TIER 3: TRUE SERVER-TO-SERVER AUTO PAY ---
              // The backend ignores client delegation bounds and securely fetches them from the user's DB record
              const res = await db.integrations.Agent.autoSettle({ invoice_id: targetId });
              
              if (res.escalation) {
                setMessages(prev => [...prev, {
                  role: 'tool',
                  tool_call_id: call.id,
                  name: 'trigger_payment',
                  content: 'Agent lacks a mandate token. Human checkout is required.',
                  uiType: 'checkout_inline',
                  uiData: { 
                    id: res.invoice_uuid || targetId,
                    order_id: res.order_id, 
                    payment_link_url: res.payment_link_url,
                    qr: `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(res.payment_link_url)}`
                  }
                }]);
              } else {
                setMessages(prev => [...prev, {
                  role: 'tool',
                  tool_call_id: call.id,
                  name: 'trigger_payment',
                  content: 'The invoice has been autonomously settled via the Server-to-Server API. No human intervention was required.',
                  uiType: 'payment_done',
                  uiData: { id: res.invoice_uuid || targetId, tx_id: res.payment_id || res.order_id }
                }]);
              }
              
            } catch (err) {
              if (err.status === 409) {
                // Idempotency protection: already settled
                setMessages(prev => [...prev, {
                  role: 'tool',
                  tool_call_id: call.id,
                  name: 'trigger_payment',
                  content: 'This invoice has already been settled. Re-settlement is blocked to prevent double payment.',
                  uiType: 'payment_done',
                  uiData: { id: targetId }
                }]);
                continue;
              }

              // Usually unvalidated (score below gate) or out of bounds
              setMessages(prev => [...prev, {
                role: 'tool',
                tool_call_id: call.id,
                name: 'trigger_payment',
                content: `ðŸš¨ Agent Blocked: I cannot settle this autonomously. Most likely this invoice has not passed human validation yet (I cannot grade my own work), or it exceeds my delegation limit. Escalating to human checkout...`,
                uiType: 'payment_blocked',
                uiData: { id: targetId }
              }]);
              // Removed setTimeout navigate so user stays in chat
            }
          }
        }
        }
      } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, I couldn't reach the agent right now: ${err.message || 'unknown error'}`
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 h-full bg-transparent relative">
      <div className="px-6 py-4 border-b bg-card z-10 shadow-sm flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden border border-border">
          <img src="/logo.png" alt="Agent" className="w-full h-full object-cover" />
        </div>
        <div>
          <h2 className="text-lg font-bold font-heading leading-tight">AgentPay Checkout</h2>
          <p className="text-xs text-muted-foreground">Automated B2B Gateway</p>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => {
          localStorage.removeItem('agent_chat_history');
          localStorage.removeItem('agent_last_invoice_id');
          localStorage.removeItem('agent_chat_session_id');
          setLastInvoiceId(null);
          setFallbackMode(false);
          setFallbackCart([]);
          setFallbackCatalog([]);
          setFallbackSimulated(false);
          setFallbackQuery('');
          setMessages([{ role: 'assistant', content: 'Chat history cleared. How can I help you?' }]);
        }}>Clear</Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex items-start gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[80%]`}>
              {msg.content && (
                <div className={`px-4 py-3 rounded-2xl text-sm shadow-sm ${msg.role === 'user' ? 'bg-muted text-foreground rounded-tr-sm' : 'bg-card border rounded-tl-sm'}`}>
                  {msg.content}
                </div>
              )}
              {msg.tool_calls && msg.tool_calls.length > 0 && (
                <div className="px-4 py-2.5 rounded-2xl shadow-sm bg-muted/30 border rounded-tl-sm mt-1 flex items-center gap-2">
                  {isTyping && idx === messages.length - 1 ? (
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  ) : (
                    <Wrench className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className={`font-mono text-xs ${isTyping && idx === messages.length - 1 ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {isTyping && idx === messages.length - 1 ? 'Executing ' : 'Used '}
                    {msg.tool_calls.map(tc => tc.function.name).join(', ')}...
                  </span>
                </div>
              )}
              
              {/* Dynamic UI Rendering based on JSON serializable types */}
              {msg.uiType === 'catalog' && msg.uiData?.results && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="flex gap-4 overflow-x-auto pb-4 snap-x hide-scrollbar">
                    {msg.uiData.results.map((item, i) => (
                      <div key={i} className="min-w-[200px] max-w-[200px] bg-card border rounded-xl p-4 flex flex-col gap-2 shadow-sm snap-start shrink-0 hover:border-primary/50 transition-colors">
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-1">
                          <Package className="w-5 h-5 text-primary" />
                        </div>
                        <h4 className="font-bold text-sm leading-tight text-foreground line-clamp-2">{item.name}</h4>
                        <p className="text-xs text-muted-foreground line-clamp-2 flex-1">{item.description}</p>
                        <div className="pt-2 mt-auto border-t flex justify-between items-center">
                          <span className="font-mono text-xs font-bold bg-muted px-2 py-1 rounded-md">₹{item.price.toLocaleString('en-IN')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {msg.uiType === 'invoice' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="bg-card border rounded-xl p-5 space-y-4 shadow-sm w-full md:min-w-[320px]">
                    <div className="flex items-start justify-between">
                      <div className="flex gap-3">
                        <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center shrink-0">
                          <FileText className="w-5 h-5 text-indigo-600" />
                        </div>
                        <div>
                          <p className="font-bold text-base text-foreground">{msg.uiData.invoice_number}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 uppercase tracking-wider">
                              Draft
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Total Due</p>
                        <p className="font-bold font-mono text-lg text-foreground">
                           View Details
                        </p>
                      </div>
                    </div>
                    
                    <div className="flex flex-col gap-2 pt-2 border-t">
                      <Button 
                        onClick={async () => {
                          const token = localStorage.getItem('app_access_token');
                          try {
                            const res = await fetch('/api/checkout/order', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ invoice_id: msg.uiData.id })
                            });
                            const orderData = await res.json();
                            if (!res.ok) throw new Error(orderData.message);

                            const options = {
                              key: import.meta.env.VITE_RAZORPAY_KEY_ID,
                              amount: orderData.amount,
                              currency: orderData.currency,
                              name: 'AgentPay Gateway',
                              description: `Checkout for ${msg.uiData.invoice_number}`,
                              order_id: orderData.order_id,
                              handler: async function (response) {
                                try {
                                  await fetch('/api/agent/verify', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                    body: JSON.stringify({
                                      razorpay_payment_id: response.razorpay_payment_id,
                                      razorpay_order_id: response.razorpay_order_id,
                                      razorpay_signature: response.razorpay_signature,
                                      invoice_id: msg.uiData.id
                                    })
                                  });
                                  toast.success('Payment successful!');
                                  setMessages(prev => [...prev, {
                                    role: 'tool', tool_call_id: 'payment_success', name: 'user_payment',
                                    content: `Payment completed for ${msg.uiData.invoice_number}. Thank you!`,
                                    uiType: 'payment_done', uiData: { id: msg.uiData.id, tx_id: response.razorpay_payment_id }
                                  }]);
                                } catch (e) {
                                  toast.error('Payment verification failed.');
                                }
                              },
                              prefill: { name: 'AI Buyer Agent', email: 'agent@commerce.copilot' },
                              theme: { color: '#4f46e5' }
                            };
                            
                            const rzp = new window.Razorpay(options);
                            rzp.on('payment.failed', function (response){ toast.error('Payment failed'); });
                            rzp.open();
                          } catch (err) {
                            toast.error(err.message || 'Failed to initialize checkout');
                          }
                        }}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-md font-bold h-10"
                      >
                        Approve & Pay Now
                      </Button>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="flex-1" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                          View Full Details
                        </Button>
                        <Button variant="ghost" size="sm" className="flex-1 text-red-500 hover:text-red-700 hover:bg-red-50" onClick={async () => {
                          const token = localStorage.getItem('app_access_token');
                          try {
                            await fetch(`/api/invoices/${msg.uiData.id}`, {
                              method: 'DELETE',
                              headers: { Authorization: `Bearer ${token}` }
                            });
                            toast.success('Draft rejected');
                            setMessages(prev => [...prev, { role: 'user', content: `I have rejected and deleted draft invoice ${msg.uiData.invoice_number}.` }]);
                          } catch (e) {
                            toast.error('Failed to delete draft');
                          }
                        }}>
                          Reject Draft
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {msg.uiType === 'payment_done' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-xl space-y-3 shadow-sm">
                    <div className="flex items-center gap-2">
                       <div className="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center text-xs shadow-sm">âœ“</div>
                       <span className="text-sm font-bold text-green-800">Payment Successful</span>
                    </div>
                    {msg.uiData.tx_id && (
                       <div className="bg-white/80 p-2 rounded-md text-xs font-mono text-green-700 border border-green-100 break-all shadow-inner">
                         TX: {msg.uiData.tx_id}
                       </div>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs h-9 shadow-sm" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                        View Invoice
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1 text-xs h-9 text-green-700 border-green-300 hover:bg-green-100" onClick={async () => {
                        try {
                          const existing = await db.entities.Invoice.read(msg.uiData.id);
                          if(existing) {
                            generateInvoicePDF(existing);
                          }
                        } catch (err) {
                          toast.error('Could not download PDF');
                        }
                      }}>
                        Download PDF
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {msg.uiType === 'checkout_inline' && msg.uiData && (
                <div className="w-full mt-2 max-w-sm mx-auto animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="bg-white border rounded-2xl shadow-lg overflow-hidden">
                    <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-medium text-gray-500">Order ID</div>
                        <div className="font-mono font-bold text-sm">{msg.uiData.order_id}</div>
                      </div>
                      <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Pending</Badge>
                    </div>
                    <div className="p-6 flex flex-col items-center">
                      <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 mb-4 inline-block">
                        <img src={msg.uiData.qr} alt="Scan to pay" className="w-40 h-40" />
                      </div>
                      <p className="text-sm text-gray-600 mb-6 text-center">
                        Scan with your UPI app or click the button below to complete the payment via Razorpay.
                      </p>
                      <div className="flex flex-col w-full gap-2">
                        <Button className="w-full bg-[#3395ff] hover:bg-[#2b7ee5] text-white shadow-md font-bold h-11" onClick={() => window.open(msg.uiData.payment_link_url, '_blank')}>
                          Open Razorpay Checkout
                        </Button>
                        <div className="flex gap-2 w-full">
                          <Button variant="outline" className="flex-1 h-11 font-medium" onClick={() => {
                            navigator.clipboard.writeText(msg.uiData.payment_link_url);
                            toast.success('Payment link copied to clipboard');
                          }}>
                            Copy Link
                          </Button>
                          <Button variant="outline" className="flex-1 h-11 font-medium border-indigo-200 text-indigo-700 hover:bg-indigo-50" onClick={async () => {
                            try {
                              const res = await fetch(`/api/invoices/${msg.uiData.id || msg.uiData.invoice_uuid || msg.uiData.order_id}`, {
                                headers: { Authorization: `Bearer ${localStorage.getItem('app_access_token')}` }
                              });
                              if (!res.ok) throw new Error();
                              const updatedInvoice = await res.json();
                              if (updatedInvoice.status === 'paid') {
                                toast.success('Payment confirmed!');
                                window.location.reload();
                              } else {
                                toast.info('Payment still pending. Please complete the checkout.');
                              }
                            } catch (e) {
                              toast.error('Failed to check status');
                            }
                          }}>
                            Check Status
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {msg.uiType === 'payment_escalated' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                    <div className="flex items-center gap-2">
                       <div className="w-6 h-6 rounded-full bg-amber-500 text-white flex items-center justify-center text-xs">!</div>
                       <span className="text-sm font-bold text-amber-800">Escalated to Human</span>
                    </div>
                    <div className="text-xs text-amber-700">
                      The agent does not have a mandate token to pay autonomously. A secure Razorpay Payment Link has been generated.
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-xs h-8 shadow-sm" onClick={() => window.open(msg.uiData.payment_link_url, '_blank')}>
                        Pay Now
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1 text-xs h-8" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                        View Invoice
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {msg.uiType === 'payment_blocked' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                    <div className="flex items-center gap-2">
                       <div className="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-xs">!</div>
                       <span className="text-sm font-bold text-red-800">Safety Gate Blocked</span>
                    </div>
                    <p className="text-xs text-red-700">This invoice exceeds my authorized limits or lacks human validation.</p>
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs h-9" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                        Review & Pay
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {msg.uiType === 'settlement_complete' && msg.uiData && (
                <div className="w-full mt-2 p-3 bg-card border rounded-lg flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-foreground">S2S Settlement Complete</p>
                    <p className="text-xs text-muted-foreground font-mono">ID: {msg.uiData.id.slice(0, 8)}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex items-start gap-4">
            <div className="px-4 py-3 bg-card border rounded-2xl rounded-tl-sm flex gap-1 items-center h-[44px]">
              <span className="w-2 h-2 rounded-full bg-primary/40 animate-bounce"></span>
              <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }}></span>
              <span className="w-2 h-2 rounded-full bg-primary/80 animate-bounce" style={{ animationDelay: '300ms' }}></span>
            </div>
          </div>
        )}
        {fallbackMode && (
          <div className="px-6 pb-4">
            <div className="max-w-4xl mx-auto bg-card border rounded-xl p-4 space-y-3 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-primary" />
                <h3 className="font-bold text-sm">Manual Checkout — Agent LLM offline</h3>
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-foreground" onClick={() => setFallbackMode(false)}>
                    Dismiss
                  </Button>
                  {fallbackSimulated && (
                    <Button size="sm" variant="default" className="h-7 text-xs" onClick={restoreAutonomousMode}>
                      Restore autonomous mode
                    </Button>
                  )}
                </div>
              </div>
              <Input value={fallbackQuery} onChange={e => setFallbackQuery(e.target.value)} placeholder="Search catalog (e.g., firewall, compliance)..." className="h-10 bg-background" />
              <div className="flex gap-2 overflow-x-auto pb-2">
                {fallbackCatalog
                  .filter(p => !fallbackQuery.trim() || (p.name || '').toLowerCase().includes(fallbackQuery.toLowerCase()) || (p.description || '').toLowerCase().includes(fallbackQuery.toLowerCase()))
                  .map(p => (
                    <div key={p.id} className="min-w-[180px] max-w-[180px] bg-background border rounded-lg p-3 flex flex-col gap-1 shrink-0">
                      <span className="text-xs font-bold leading-tight line-clamp-2">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground flex-1">₹{Number(p.price).toLocaleString('en-IN')}</span>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => fallbackAdd(p)}>Add to Cart</Button>
                    </div>
                  ))}
              </div>
              {fallbackCart.length > 0 && (
                <div className="border-t pt-2 space-y-1">
                  {fallbackCart.map(i => (
                    <div key={i.id} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate">{i.name}</span>
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => fallbackQty(i.id, -1)}>−</Button>
                      <span className="w-6 text-center font-mono text-xs">{i.quantity}</span>
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => fallbackQty(i.id, 1)}>+</Button>
                      <span className="w-20 text-right font-mono text-xs">₹{(i.price * i.quantity).toLocaleString('en-IN')}</span>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500" onClick={() => fallbackRemove(i.id)}>×</Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-muted-foreground">GST 18% applied at invoice time</span>
                    <Button size="sm" onClick={fallbackCheckout}>Generate Invoice</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      <div className="p-4 bg-background border-t">
        <form onSubmit={handleSend} className="relative max-w-4xl mx-auto flex gap-2">
          <Input 
            value={input} 
            onChange={e => setInput(e.target.value)}
            placeholder="Type a command (e.g., 'Show me the catalog' or 'Buy IT License')..." 
            className="pr-12 h-12 bg-card border-muted-foreground/20 rounded-xl focus-visible:ring-primary shadow-sm text-sm"
            disabled={isTyping}
          />
          <Button type="submit" size="icon" className="absolute right-1 top-1 h-10 w-10 rounded-lg shrink-0 transition-transform active:scale-95 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90" disabled={!input.trim() || isTyping}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
        <p className="text-center text-[10px] text-muted-foreground mt-3 font-medium tracking-wide">
          <Shield className="w-3 h-3 inline-block mr-1 opacity-70" />
          Powered by Agentic Commerce Engine — B2B Operations
        </p>
      </div>
    </div>
  );
}
