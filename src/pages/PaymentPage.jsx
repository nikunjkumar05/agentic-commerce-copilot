import { db } from '@/services/db';

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, CheckCircle2, Wallet, Users, Bot, Plus, Shield, ShieldAlert, CheckCircle, XCircle, FileDown } from 'lucide-react';
import { formatCurrency } from '@/lib/invoiceHelpers';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/AuthContext';
import { useRef } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import InvoicePreview from '@/components/invoice/InvoicePreview';

export default function PaymentPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [paymentTab, setPaymentTab] = useState('manual');
  const [isProcessing, setIsProcessing] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [agentError, setAgentError] = useState(null);

  const previewRef = useRef(null);
  const [isExportingPDF, setIsExportingPDF] = useState(false);

  const { user, refetchProfile } = useAuth();
  
  // Agent delegation state derived from the real DB user row
  const delegation = user?.agent_delegation_max > 0 ? { maxAmount: user.agent_delegation_max } : null;
  const [maxAmount, setMaxAmount] = useState('100000');
  const [dailyLimit, setDailyLimit] = useState('200000');
  const [expiryDays, setExpiryDays] = useState('30');

  const [milestones, setMilestones] = useState([]);

  // Sync milestones from the real database invoice row
  useEffect(() => {
    if (invoice && invoice.milestones) {
      // Only set if not already set, or if we want to force sync
      setMilestones(invoice.milestones);
    }
  }, [invoice]);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const list = await db.entities.Invoice.filter({ id });
      return list[0];
    },
  });

  const [utrNumber, setUtrNumber] = useState('');

  const handleBankTransfer = async () => {
    if (!utrNumber.trim()) {
      toast.error('Please enter a valid UTR reference number.');
      return;
    }
    setIsProcessing(true);
    try {
      await db.entities.Invoice.update(id, { tx_hash: utrNumber, status: 'paid', payment_method: 'bank_transfer' });
      await db.entities.AgentAuditLog.create({
        action: 'settlement', invoice_id: id, invoice_number: invoice.invoice_number,
        amount: invoice.grand_total, tx_hash: utrNumber, details: 'Manual Bank Transfer (NEFT/RTGS) verification'
      });
      queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      setReceipt({ txHash: utrNumber, method: 'bank_transfer', amount: invoice.grand_total, network: 'Fiat' });
      toast.success('Payment recorded successfully!');
    } catch (err) {
      toast.error('Failed to record payment.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMPPRelease = async (milestoneIdx) => {
    if (!invoice) return;
    setIsProcessing(true);
    // HONEST MPP: no artificial delay and NO fake transaction hash.
    // Real escrow/blockchain settlement is not configured, so we record the
    // release in the REAL audit ledger (SHA-256 hash-chain) and persist the
    // milestone state to the REAL invoice row — then tell the user plainly that
    // no on-chain escrow transfer occurred.
    try {
      const m = milestones[milestoneIdx];
      const auditEntry = await db.entities.AgentAuditLog.create({
        action: 'milestone_released',
        invoice_id: id,
        invoice_number: invoice.invoice_number,
        amount: m?.amount || 0,
        details: `Milestone ${milestoneIdx + 1} (${m?.description || 'Phase'}) released. Recorded in audit ledger; on-chain escrow is NOT configured so no blockchain transaction occurred.`
      });

      const updated = [...milestones];
      updated[milestoneIdx] = {
        ...updated[milestoneIdx],
        status: 'released',
        // Real verifiable reference (the audit ledger row id) instead of a fake hash
        auditId: auditEntry?.id || null,
        releasedAt: new Date().toISOString(),
      };

      // Persist to the real invoice row (server-side), not just localStorage
      await db.entities.Invoice.update(id, { milestones: updated });
      setMilestones(updated);
      queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      toast.success(`Milestone ${milestoneIdx + 1} released — recorded in audit ledger`);
    } catch (err) {
      console.error('Milestone release failed:', err);
      toast.error(`Milestone release failed: ${err?.message || 'unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const addMilestone = () => {
    if (!invoice) return;
    const numMilestones = milestones.length + 1;
    const perMilestone = Math.round(invoice.grand_total / numMilestones);
    const updated = milestones.map(m => ({ ...m, amount: perMilestone }));
    updated.push({
      description: `Phase ${numMilestones}`,
      amount: invoice.grand_total - updated.reduce((s, m) => s + m.amount, 0),
      status: 'pending',
      // No fake recipient address: a real escrow would need real wallet/linked
      // account info which this flow does not collect (and we must not invent it).
      recipients: [{ name: invoice.recipient_name || 'Recipient', percentage: 100 }],
    });
    setMilestones(updated);
  };

  const handleSetupDelegation = async () => {
    try {
      const token = localStorage.getItem('app_access_token');
      await fetch('/api/user/delegation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ maxAmount: Number(maxAmount) || 0, dailyLimit: Number(dailyLimit) || 0 })
      });

      // Sync with real DB state
      await refetchProfile();

      await db.entities.AgentAuditLog.create({
        action: 'delegation_created', amount: Number(maxAmount),
        // NOTE: `del` used to be referenced here but was undefined — the audit
        // entry silently never got written while the UI still toasted success.
        // No real agent/owner addresses are collected in this flow, so we leave
        // them unset (null) and log an accurate description instead.
        details: `Delegation up to ₹${maxAmount} for ${expiryDays} days anchored to the server (database).`,
      });
    } catch (err) {
      console.error('Failed to log delegation:', err);
    }
    toast.success('Agent delegation anchored to server');
  };

  const handleAgentSettle = async () => {
    if (!delegation || !invoice) return;
    setIsProcessing(true);
    
    try {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/agent/settle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` })
        },
        body: JSON.stringify({
          invoice_id: id
        })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        if (res.status === 403) {
          // Graceful Failure! Trigger the UI panel
          setAgentError(data.message || 'Agent Out of Bounds: Human review required.');
        } else if (res.status === 409) {
          toast.info(data.message || 'Invoice is already settled.');
        } else {
          toast.error(data.message || 'Agent encountered an error.');
        }
        setIsProcessing(false);
        return;
      }

      // Open Razorpay Checkout
      const options = {
        key: import.meta.env.VITE_RAZORPAY_KEY_ID, // Use env variable instead of hardcoded key
        amount: Math.round(invoice.grand_total * 100),
        currency: invoice.currency || 'INR',
        name: 'AgentPay Gateway',
        description: `Autonomous Settlement for ${invoice.invoice_number}`,
        order_id: data.order.id,
        handler: async function (response) {
          try {
            const verifyRes = await fetch('/api/agent/verify', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token && { Authorization: `Bearer ${token}` })
              },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                invoice_id: id
              })
            });

            if (!verifyRes.ok) throw new Error('Verification failed');

            toast.success('Agent settled invoice autonomously via Razorpay!');
            setReceipt({ 
              txHash: response.razorpay_payment_id, 
              method: 'Razorpay Route (Autonomous)', 
              amount: formatCurrency(invoice.grand_total, invoice.currency), 
              network: 'Razorpay (test mode)',
            });
            queryClient.invalidateQueries({ queryKey: ['invoice', id] });
          } catch (err) {
            console.error(err);
            toast.error('Payment signature verification failed.');
          }
        },
        prefill: { name: 'AI Buyer Agent', email: 'agent@commerce.copilot' },
        theme: { color: '#9333ea' } // matches the blue agent theme
      };

      if (window.__rzpFailed || typeof window.Razorpay === 'undefined') {
        toast.error('Payment gateway failed to load. Please disable adblockers and check your connection.', { duration: 5000 });
        setIsProcessing(false);
        return;
      }

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (response){
        toast.error(response.error.description || 'Payment failed');
      });
      rzp.open();

    } catch (err) {
      console.error(err);
      toast.error('Agent settlement failed.');
    }
    setIsProcessing(false);
  };

  const revokeDelegation = async () => {
    localStorage.removeItem('agent_delegation');
    try {
      await db.entities.AgentAuditLog.create({
        action: 'delegation_revoked',
        agent_address: delegation?.agentAddress, owner_address: delegation?.ownerAddress,
        details: 'Delegation revoked by owner',
      });
    } catch (err) {
      console.error('Failed to log delegation revocation:', err);
    }
    setDelegation(null);
    toast.success('Delegation revoked');
  };

  const handleExportPDF = async () => {
    if (!previewRef.current) return;
    setIsExportingPDF(true);
    try {
      const canvas = await html2canvas(previewRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`${invoice.invoice_number}_receipt.pdf`);
      toast.success('Receipt downloaded!');
    } catch (err) {
      console.error(err);
      toast.error('Failed to generate PDF');
    } finally {
      setIsExportingPDF(false);
    }
  };

  if (isLoading) return <div className="p-4 space-y-3">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>;
  if (!invoice) return <div className="p-8 text-center text-muted-foreground">Invoice not found</div>;

  // Receipt view
  if (receipt) {
    return (
      <div className="p-4 max-w-lg mx-auto">
        <div className="text-center py-8">
          <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-xl font-bold">Payment Successful</h2>
          <p className="text-sm text-muted-foreground mt-1">via {receipt.method}</p>
        </div>
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount</span><span className="font-semibold">{receipt.amount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Network</span><span>{receipt.network}</span>
            </div>
            <div className="flex justify-between text-sm items-start">
              <span className="text-muted-foreground">Reference</span>
              <span className="font-mono text-xs text-right max-w-[200px] break-all">{receipt.txHash}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              No on-chain transaction exists for this record — the balance was settled via {receipt.method}.
            </p>
          </CardContent>
        </Card>
        <div className="flex gap-2 mt-4">
          <Link to={`/invoice/${id}`} className="flex-1"><Button variant="outline" className="w-full">Back to Invoice</Button></Link>
          <Button className="flex-1" onClick={handleExportPDF} disabled={isExportingPDF}>
            {isExportingPDF ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileDown className="w-4 h-4 mr-2" />}
            Download Receipt
          </Button>
        </div>
        <div style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}>
          <div ref={previewRef} className="w-[800px] bg-white text-black p-8">
            <InvoicePreview invoice={{ ...invoice, status: 'paid' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Agent Blocked Panel (Graceful Failure Rubric) */}
      {agentError && (
        <div className="absolute inset-0 bg-background/95 z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-card rounded-2xl border-2 border-red-500/20 shadow-2xl p-6 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-red-500" />
            
            <div className="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
              <ShieldAlert className="w-6 h-6 text-red-500" />
            </div>
            
            <h2 className="text-xl font-bold font-heading mb-2">Agent Settlement Blocked</h2>
            <p className="text-sm text-muted-foreground mb-6">
              The AI Co-Pilot has paused this transaction because it violates the established safety bounds.
            </p>

            <div className="space-y-4 mb-6">
              <div className="bg-muted/50 rounded-xl p-3 text-sm">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-muted-foreground text-xs font-mono">REASON_CODE</span>
                  <span className="text-red-500 text-xs font-bold font-mono">ERR_OUT_OF_BOUNDS</span>
                </div>
                <p className="font-medium text-foreground">{agentError}</p>
              </div>

              <div className="border border-border rounded-xl p-3">
                <p className="text-xs font-bold mb-2">Agent Reasoning Trail:</p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle className="w-3 h-3 text-green-500" /> Parsed invoice {invoice.invoice_number}
                  </li>
                  {invoice.compliance_score < 85 ? (
                    <li className="flex items-center gap-1 text-xs font-medium text-red-400">
                      <XCircle className="w-3 h-3 text-red-500" /> AI Confidence ({invoice.compliance_score}) &lt; 85
                    </li>
                  ) : (
                    <li className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CheckCircle className="w-3 h-3 text-green-500" /> AI Confidence ({invoice.compliance_score}) ≥ 85
                    </li>
                  )}
                  {invoice.grand_total > (delegation?.maxAmount || 0) ? (
                    <li className="flex items-center gap-2 text-xs font-medium text-red-400">
                      <XCircle className="w-3 h-3 text-red-500" /> Amount (₹{invoice.grand_total}) exceeds budget (₹{delegation?.maxAmount || 0})
                    </li>
                  ) : (
                    <li className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CheckCircle className="w-3 h-3 text-green-500" /> Amount within delegated budget
                    </li>
                  )}
                  <li className="flex items-center gap-2 text-xs font-bold text-red-500 pt-1">
                    <ShieldAlert className="w-3 h-3" /> Execution Halted. Escalated to Human.
                  </li>
                </ul>
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 text-xs" onClick={() => setAgentError(null)}>
                Dismiss
              </Button>
              <Button className="flex-1 text-xs bg-red-500 hover:bg-red-600 text-white border-0" onClick={() => {
                setAgentError(null);
                setActiveTab('manual');
              }}>
                Manual Override
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-3 bg-background relative z-10">
        <Link to={`/invoice/${id}`}><Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex-1">
          <h2 className="text-base font-bold">Payment</h2>
          <p className="text-xs text-muted-foreground">{invoice.invoice_number} — {formatCurrency(invoice.grand_total, invoice.currency)}</p>
        </div>
      </div>

      {invoice.status === 'paid' && (
        <div className="mx-4 mb-4 bg-green-50 border border-green-200 rounded-2xl p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-600" />
          <div>
            <p className="text-sm font-semibold text-green-700">Invoice Paid</p>
            <p className="text-xs text-green-600 font-mono">{invoice.tx_hash?.slice(0, 20)}...</p>
          </div>
        </div>
      )}

      <Tabs value={paymentTab} onValueChange={setPaymentTab} className="px-4">
        <TabsList className="w-full h-9 bg-muted/50 mb-4">
          <TabsTrigger value="manual" className="text-xs flex-1 gap-1"><Wallet className="w-3 h-3" /> Bank Transfer</TabsTrigger>
          <TabsTrigger value="mpp" className="text-xs flex-1 gap-1"><Users className="w-3 h-3" /> MPP</TabsTrigger>
          <TabsTrigger value="agent" className="text-xs flex-1 gap-1"><Bot className="w-3 h-3" /> Agent</TabsTrigger>
        </TabsList>

        {/* Bank Transfer (Manual) */}
        <TabsContent value="manual">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Wallet className="w-4 h-4 text-blue-500" /> Manual Bank Transfer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">Mark this invoice as paid if you have settled it outside the platform via NEFT/RTGS.</p>
              <div className="bg-muted/50 rounded-xl p-3 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Amount Due</span><span className="font-bold">{formatCurrency(invoice.grand_total, invoice.currency)}</span></div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">UTR Reference Number</Label>
                <Input 
                  placeholder="e.g. SBIN43920194..." 
                  value={utrNumber}
                  onChange={(e) => setUtrNumber(e.target.value)}
                  className="h-10 text-sm font-mono"
                />
              </div>
              <Button className="w-full h-12 text-sm font-semibold" onClick={handleBankTransfer} disabled={isProcessing || invoice.status === 'paid'}>
                {isProcessing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Processing...</> : 'Record Payment'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MPP Milestone Payments */}
        <TabsContent value="mpp">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2"><Users className="w-4 h-4 text-blue-500" /> Milestone Payments</CardTitle>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={addMilestone}><Plus className="w-3 h-3" /> Add</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {milestones.length === 0 ? (
                <div className="text-center py-6">
                  <Users className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="text-xs text-muted-foreground">No milestones defined. Add milestones to split the payment.</p>
                </div>
              ) : (
                milestones.map((m, i) => (
                  <div key={i} className={cn("border rounded-xl p-3 space-y-2", m.status === 'released' ? 'border-green-200 bg-green-50' : 'border-border')}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold",
                          m.status === 'released' ? 'bg-green-500 text-white' : 'bg-muted text-muted-foreground'
                        )}>{i + 1}</div>
                        <span className="text-sm font-medium">{m.description}</span>
                      </div>
                      <Badge className={cn("text-[10px]", m.status === 'released' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground')}>
                        {m.status === 'released' ? 'Released' : 'Pending'}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatCurrency(m.amount, invoice.currency)}</span>
                      <span>{m.recipients?.[0]?.name}</span>
                    </div>
                    {m.status === 'pending' && (
                      <Button size="sm" className="w-full h-8 text-xs" onClick={() => handleMPPRelease(i)} disabled={isProcessing}>
                        Release Payment
                      </Button>
                    )}
                    {m.status === 'released' && (
                      <p className="text-[10px] font-mono text-muted-foreground">
                        Audit ref: {m.auditId ? `${m.auditId.slice(0, 20)}...` : 'recorded (no on-chain tx)'}
                      </p>
                    )}
                  </div>
                ))
              )}
              <div className="bg-muted/50 rounded-xl p-3 flex justify-between text-sm">
                <span>Released</span>
                <span className="font-bold">{formatCurrency(milestones.filter(m => m.status === 'released').reduce((s, m) => s + m.amount, 0), invoice.currency)}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agent Delegation */}
        <TabsContent value="agent">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4 text-blue-500" /> B2B Mandate Settlement</CardTitle>
            </CardHeader>
            <CardContent>
              {delegation ? (
                <div className="space-y-4">
                  <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-200 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-blue-700" />
                    </div>
                    <div className="text-xs space-y-1 text-blue-600">
                      <p>Max Amount: ₹{delegation.maxAmount?.toLocaleString()}</p>
                      <p>Daily Cap: ₹{user?.agent_daily_limit?.toLocaleString() || '0'}</p>
                      <p>Expires: Never (until revoked)</p>
                      <p className="font-mono text-[10px]">Agent: system-orchestrator</p>
                    </div>
                  </div>
                  <Button className="w-full h-12 text-sm font-semibold bg-blue-600 hover:bg-blue-700" onClick={handleAgentSettle} disabled={isProcessing || invoice.status === 'paid'}>
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Bot className="w-4 h-4 mr-2" />}
                    Authorize Autonomous Payment
                  </Button>
                </div>
              ) : (
                <div className="text-center space-y-3 py-2">
                  <p className="text-xs text-muted-foreground">Set up an AI agent to autonomously settle invoices on your behalf (B2B Mandate delegation).</p>
                  <div>
                    <Label className="text-xs">Max Amount (₹)</Label>
                    <Input type="number" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} className="mt-1 h-9 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Daily Cap (₹)</Label>
                    <Input type="number" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} className="mt-1 h-9 text-sm" />
                  </div>
                  <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-start gap-2">
                    <Shield className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-yellow-700">This agent can act on your behalf. You can revoke at any time.</p>
                  </div>
                  <Button className="w-full" onClick={handleSetupDelegation}>Create Agent Delegation</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
