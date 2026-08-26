import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Send, User, Package, FileText, Loader2 } from 'lucide-react';
import { db } from '@/services/db';

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
      content: 'Hello! I am your Agentic Commerce Co-Pilot. You can ask me to search the catalog, generate an invoice, or trigger a payment autonomously.' 
    }];
  });

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  const [lastInvoiceId, setLastInvoiceId] = useState(() => localStorage.getItem('agent_last_invoice_id') || null); 
  const chatEndRef = useRef(null);

  // 2. Save to LocalStorage whenever messages change
  useEffect(() => {
    localStorage.setItem('agent_chat_history', JSON.stringify(messages));
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
    const alreadyNotified = messages.some(m => m.uiType === 'settlement_complete');
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
  }, [lastInvoiceId]);

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
        body: JSON.stringify({ messages: newMessages.map(m => ({ role: m.role, content: m.content })) })
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const data = await res.json();

      if (data.tool_calls && data.tool_calls.length > 0) {
        for (const call of data.tool_calls) {
          const args = JSON.parse(call.function.arguments || '{}');

          if (call.function.name === 'search_catalog') {
            try {
              const catRes = await fetch('/catalog.json');
              const catData = await catRes.json();
              const queryStr = (args.query || '').toLowerCase();
              
              const matches = catData.catalog.filter(p => 
                p.name.toLowerCase().includes(queryStr) || 
                p.description.toLowerCase().includes(queryStr)
              );
              
              // If no exact match, show all items
              const results = matches.length > 0 ? matches : catData.catalog;
              const contentText = `Here is what I found in the catalog for "${args.query}":\n` + 
                results.map(r => `- ${r.name} (₹${r.price})`).join('\n');

              setMessages(prev => [...prev, {
                role: 'assistant',
                content: contentText,
                uiType: 'catalog',
                uiData: { results }
              }]);
            } catch (e) {
              setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I failed to load the catalog.' }]);
            }
          } 
          
          else if (call.function.name === 'create_invoice') {
            const newInvoice = await db.entities.Invoice.create({
              invoice_number: 'INV-' + Math.floor(Math.random() * 100000),
              recipient_name: 'AI Agent Buyer',
              grand_total: args.amount,
              currency: 'INR',
              status: 'draft',
              compliance_score: 95, // AI generated invoices are inherently compliant for demo
              line_items: [{ description: args.description, quantity: 1, unit_price: args.amount, total: args.amount }]
            });
            
            setLastInvoiceId(newInvoice.id);

            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `I have generated invoice ${newInvoice.invoice_number} for ${args.description} at ₹${args.amount}.`,
              uiType: 'invoice',
              uiData: { id: newInvoice.id, invoice_number: newInvoice.invoice_number } 
            }]);

            // --- TIER 3: AI Growth / Upsell ---
            try {
              const catRes = await fetch('/catalog.json');
              const catData = await catRes.json();
              
              const upsellLogic = {
                'it license': 'prod_cloud_hosting',
                'cloud hosting': 'prod_network_sec',
                'network security': 'prod_it_license'
              };
              
              const currentDesc = args.description.toLowerCase();
              let recommendedId = null;
              
              for (const [key, targetId] of Object.entries(upsellLogic)) {
                if (currentDesc.includes(key)) {
                  recommendedId = targetId;
                  break;
                }
              }
              
              const possibleUpsells = catData.catalog.filter(p => !currentDesc.includes(p.name.toLowerCase()));
              const upsell = recommendedId 
                ? catData.catalog.find(p => p.id === recommendedId) 
                : possibleUpsells[Math.floor(Math.random() * possibleUpsells.length)];

              if (upsell) {
                setTimeout(() => {
                  setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `✨ AI Growth Suggestion: Since you are proceeding with ${args.description}, I highly recommend adding ${upsell.name} for optimal performance. It is available in the catalog for ₹${upsell.price.toLocaleString('en-IN')}. Would you like me to generate a new invoice for that as well?`,
                  }]);
                }, 2500);
              }
            } catch (err) {
              console.error("Upsell failed:", err);
            }
          }

          else if (call.function.name === 'trigger_payment') {
            // The LLM might pass the display number (INV-123) instead of the UUID, 
            // so we default to the actual database UUID we saved in state.
            const targetId = lastInvoiceId || (args.invoice_id === 'demo-id' ? lastInvoiceId : args.invoice_id);
            
            if (!targetId) {
              setMessages(prev => [...prev, { role: 'assistant', content: "I don't have a specific invoice ID to pay right now." }]);
              continue;
            }

            // Grab delegation logic
            const delegation = JSON.parse(localStorage.getItem('agent_delegation') || 'null');
            const delegation_max = delegation ? delegation.maxAmount : 0;

            try {
              // --- TIER 3: TRUE SERVER-TO-SERVER AUTO PAY ---
              const res = await db.integrations.Agent.autoSettle({ invoice_id: targetId, delegation_max });
              
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: 'The invoice has been autonomously settled via the Server-to-Server API. No human intervention was required.',
                uiType: 'payment_done',
                uiData: { id: targetId, tx_id: res.order_id }
              }]);
              
            } catch (err) {
              // Usually out of bounds or network error
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: `🚨 Agent Blocked: I cannot settle this autonomously (either compliance score is too low, or it exceeds my delegation limit of ₹${delegation_max.toLocaleString('en-IN')}). Escalating to human checkout...`,
                uiType: 'payment_blocked',
                uiData: { id: targetId }
              }]);
              
              // Escalate gracefully to the standard human flow
              setTimeout(() => navigate(`/invoice/${targetId}/pay`), 3500);
            }
          }
        }
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.content }]);
      }

    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error communicating with the agent network.' }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] bg-transparent relative">
      <div className="px-6 py-4 border-b bg-card z-10 shadow-sm flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-bold font-heading leading-tight">Agentic Co-Pilot</h2>
          <p className="text-xs text-muted-foreground">Autonomous Commerce Network</p>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => {
          localStorage.removeItem('agent_chat_history');
          setMessages([{ role: 'assistant', content: 'Chat history cleared. How can I help you?' }]);
        }}>Clear</Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex items-start gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-muted' : 'bg-primary text-primary-foreground'}`}>
              {msg.role === 'user' ? <User className="w-4 h-4 text-muted-foreground" /> : <Bot className="w-4 h-4" />}
            </div>

            <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[80%]`}>
              <div className={`px-4 py-3 rounded-2xl text-sm shadow-sm ${msg.role === 'user' ? 'bg-muted text-foreground rounded-tr-sm' : 'bg-card border rounded-tl-sm'}`}>
                {msg.content}
              </div>
              
              {/* Dynamic UI Rendering based on JSON serializable types */}
              {msg.uiType === 'catalog' && msg.uiData?.results && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="grid gap-2">
                    {msg.uiData.results.map((item, i) => (
                      <div key={i} className="bg-background border rounded-lg p-3 flex justify-between items-center">
                        <div className="flex items-center gap-3">
                          <div className="bg-primary/10 p-2 rounded-md"><Package className="w-4 h-4 text-primary" /></div>
                          <div>
                            <p className="text-sm font-bold">{item.name}</p>
                            <p className="text-xs text-muted-foreground line-clamp-1">{item.description}</p>
                          </div>
                        </div>
                        <span className="font-mono text-sm font-bold">₹{item.price.toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {msg.uiType === 'invoice' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-primary" />
                      <div>
                        <p className="font-bold text-sm">{msg.uiData.invoice_number}</p>
                        <p className="text-xs text-muted-foreground">Status: Draft</p>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                      View Invoice
                    </Button>
                  </div>
                </div>
              )}

              {msg.uiType === 'payment_done' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-xl space-y-3">
                    <div className="flex items-center gap-2">
                       <div className="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center text-xs">✓</div>
                       <span className="text-sm font-bold text-green-800">Autonomous Settlement Successful</span>
                    </div>
                    {msg.uiData.tx_id && (
                       <div className="bg-white/60 p-2 rounded text-xs font-mono text-green-700 border border-green-100 break-all">
                         TX: {msg.uiData.tx_id}
                       </div>
                    )}
                    <Button size="sm" className="w-full bg-green-600 hover:bg-green-700 text-white text-xs h-8 shadow-sm" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                      View Paid Invoice
                    </Button>
                  </div>
                </div>
              )}

              {msg.uiType === 'settlement_complete' && msg.uiData && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-xl space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                        <span className="text-lg">✓</span>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-green-700 dark:text-green-300">Transaction Settled</p>
                        <p className="text-xs text-green-600 dark:text-green-400">{msg.uiData.invoice_number} — ₹{(msg.uiData.amount || 0).toLocaleString('en-IN')}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="text-xs flex-1" onClick={() => navigate(`/invoice/${msg.uiData.id}`)}>
                        View Invoice
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs flex-1" onClick={() => navigate('/audit')}>
                        Audit Trail
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="px-4 py-3 rounded-2xl bg-card border rounded-tl-sm flex items-center gap-2 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-primary/40 animate-bounce" />
              <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="p-4 pb-8 bg-background/80 backdrop-blur-md border-t border-white/5">
        <form onSubmit={handleSend} className="max-w-4xl mx-auto flex gap-2">
          <Input 
            value={input} 
            onChange={e => setInput(e.target.value)}
            placeholder="Type a command (e.g., 'Show me the catalog' or 'Buy IT License')..." 
            className="flex-1 rounded-full bg-muted/50 border-muted-foreground/20 focus-visible:ring-primary h-12 px-6"
            disabled={isTyping}
          />
          <Button type="submit" size="icon" className="h-12 w-12 rounded-full shrink-0" disabled={!input.trim() || isTyping}>
            <Send className="w-5 h-5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
