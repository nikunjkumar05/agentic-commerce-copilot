import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Send, User, Package, FileText, Loader2 } from 'lucide-react';
import { db } from '@/services/db';

export default function AgentChat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([
    { 
      role: 'assistant', 
      content: 'Hello! I am your Agentic Commerce Co-Pilot. You can ask me to search the catalog, generate an invoice, or trigger a payment autonomously.' 
    }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [lastInvoiceId, setLastInvoiceId] = useState(null); 
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

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
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `Here is what I found in the catalog for "${args.query}":`,
              ui: (
                <div className="mt-3 grid gap-2">
                  <div className="bg-background border rounded-lg p-3 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="bg-primary/10 p-2 rounded-md"><Package className="w-4 h-4 text-primary" /></div>
                      <div>
                        <p className="text-sm font-bold">Enterprise IT License</p>
                        <p className="text-xs text-muted-foreground">Annual subscription</p>
                      </div>
                    </div>
                    <span className="font-mono text-sm font-bold">₹5,000</span>
                  </div>
                  <div className="bg-background border rounded-lg p-3 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="bg-primary/10 p-2 rounded-md"><Package className="w-4 h-4 text-primary" /></div>
                      <div>
                        <p className="text-sm font-bold">Cloud Hosting</p>
                        <p className="text-xs text-muted-foreground">Monthly dedicated server</p>
                      </div>
                    </div>
                    <span className="font-mono text-sm font-bold">₹12,000</span>
                  </div>
                </div>
              )
            }]);
          } 
          
          else if (call.function.name === 'create_invoice') {
            const newInvoice = await db.entities.Invoice.create({
              invoice_number: 'INV-' + Math.floor(Math.random() * 100000),
              recipient_name: 'AI Agent Buyer',
              grand_total: args.amount,
              currency: 'INR',
              status: 'draft',
              line_items: [{ description: args.description, quantity: 1, unit_price: args.amount, total: args.amount }]
            });
            
            setLastInvoiceId(newInvoice.id);

            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `I have generated an invoice for ${args.description} at ₹${args.amount}.`,
              ui: (
                <div className="mt-3 bg-primary/5 border border-primary/20 rounded-lg p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-primary" />
                    <div>
                      <p className="font-bold text-sm">{newInvoice.invoice_number}</p>
                      <p className="text-xs text-muted-foreground">Status: Draft</p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => navigate(`/invoice/${newInvoice.id}`)}>
                    View Invoice
                  </Button>
                </div>
              )
            }]);
          }

          else if (call.function.name === 'trigger_payment') {
            const targetId = args.invoice_id === 'demo-id' ? lastInvoiceId : args.invoice_id;
            
            if (!targetId) {
              setMessages(prev => [...prev, { role: 'assistant', content: "I don't have a specific invoice ID to pay right now." }]);
              continue;
            }

            setMessages(prev => [...prev, {
              role: 'assistant',
              content: 'Executing autonomous payment routing...',
              ui: (
                <div className="mt-3 p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg flex items-center justify-between">
                  <span className="text-sm font-medium text-purple-700 dark:text-purple-300">Routing to Agent Settlement...</span>
                  <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                </div>
              )
            }]);

            setTimeout(() => navigate(`/invoice/${targetId}/pay`), 2000);
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
    <div className="flex flex-col h-[calc(100vh-120px)] bg-background relative">
      <div className="px-6 py-4 border-b bg-card z-10 shadow-sm flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-bold font-heading leading-tight">Agentic Co-Pilot</h2>
          <p className="text-xs text-muted-foreground">Autonomous Commerce Network</p>
        </div>
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
              {msg.ui && (
                <div className="w-full mt-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  {msg.ui}
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

      <div className="p-4 bg-background border-t">
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
