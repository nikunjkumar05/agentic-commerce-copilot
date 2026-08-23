import { db } from '@/services/db';

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, CheckCircle2, Wallet, Zap, Users, Bot, ExternalLink, Plus, Shield } from 'lucide-react';
import { formatCurrency, generateTxHash } from '@/lib/invoiceHelpers';
import { cn } from '@/lib/utils';

export default function PaymentPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [paymentTab, setPaymentTab] = useState('x402');
  const [isProcessing, setIsProcessing] = useState(false);
  const [receipt, setReceipt] = useState(null);

  // Agent delegation state
  const [delegation, setDelegation] = useState(() => {
    const stored = localStorage.getItem('agent_delegation');
    return stored ? JSON.parse(stored) : null;
  });
  const [maxAmount, setMaxAmount] = useState('100000');
  const [expiryDays, setExpiryDays] = useState('30');

  // Milestones state
  const [milestones, setMilestones] = useState([]);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const list = await db.entities.Invoice.filter({ id });
      return list[0];
    },
  });

  const handleX402Payment = async () => {
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 2500));
    const txHash = generateTxHash();
    await db.entities.Invoice.update(id, { tx_hash: txHash, status: 'paid', payment_method: 'x402' });
    await db.entities.AgentAuditLog.create({
      action: 'settlement', invoice_id: id, invoice_number: invoice.invoice_number,
      amount: invoice.grand_total, tx_hash: txHash, details: 'x402 protocol payment'
    });
    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    setReceipt({ txHash, method: 'x402', amount: '0.001 ETH', network: 'Optimism Sepolia' });
    setIsProcessing(false);
    toast.success('Payment successful!');
  };

  const handleMPPRelease = async (milestoneIdx) => {
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 2000));
    const txHash = generateTxHash();
    const updated = [...milestones];
    updated[milestoneIdx] = { ...updated[milestoneIdx], status: 'released', txHash };
    setMilestones(updated);
    toast.success(`Milestone ${milestoneIdx + 1} released`);
    setIsProcessing(false);
  };

  const addMilestone = () => {
    if (!invoice) return;
    const remaining = invoice.grand_total - milestones.reduce((s, m) => s + m.amount, 0);
    setMilestones([...milestones, {
      description: `Phase ${milestones.length + 1}`,
      amount: Math.max(0, remaining),
      status: 'pending',
      recipients: [{ name: invoice.recipient_name || 'Recipient', address: '0x...', percentage: 100 }],
    }]);
  };

  const handleSetupDelegation = () => {
    const del = {
      maxAmount: Number(maxAmount),
      expiry: new Date(Date.now() + Number(expiryDays) * 86400000).toISOString(),
      agentAddress: '0x' + 'a1b2c3d4e5'.repeat(4),
      ownerAddress: '0x' + 'f6e7d8c9b0'.repeat(4),
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem('agent_delegation', JSON.stringify(del));
    setDelegation(del);
    db.entities.AgentAuditLog.create({
      action: 'delegation_created', amount: Number(maxAmount),
      agent_address: del.agentAddress, owner_address: del.ownerAddress,
      details: `Delegation up to ₹${maxAmount} for ${expiryDays} days`,
    });
    toast.success('Agent delegation created');
  };

  const handleAgentSettle = async () => {
    if (!delegation || !invoice) return;
    if (invoice.grand_total > delegation.maxAmount) {
      toast.error('Amount exceeds delegation limit');
      return;
    }
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 3000));
    const txHash = generateTxHash();
    await db.entities.Invoice.update(id, { tx_hash: txHash, status: 'paid', payment_method: 'erc8004' });
    await db.entities.AgentAuditLog.create({
      action: 'settlement', invoice_id: id, invoice_number: invoice.invoice_number,
      amount: invoice.grand_total, tx_hash: txHash,
      agent_address: delegation.agentAddress, owner_address: delegation.ownerAddress,
      details: 'ERC-8004 autonomous agent settlement',
    });
    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    setReceipt({ txHash, method: 'ERC-8004 Agent', amount: formatCurrency(invoice.grand_total, invoice.currency), network: 'Optimism Sepolia' });
    setIsProcessing(false);
    toast.success('Agent settled invoice autonomously!');
  };

  const revokeDelegation = () => {
    localStorage.removeItem('agent_delegation');
    db.entities.AgentAuditLog.create({
      action: 'delegation_revoked',
      agent_address: delegation?.agentAddress, owner_address: delegation?.ownerAddress,
      details: 'Delegation revoked by owner',
    });
    setDelegation(null);
    toast.success('Delegation revoked');
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
              <span className="text-muted-foreground">TX Hash</span>
              <span className="font-mono text-xs text-right max-w-[200px] break-all">{receipt.txHash}</span>
            </div>
            <a href={`https://sepolia-optimism.etherscan.io/tx/${receipt.txHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary font-medium">
              View on Explorer <ExternalLink className="w-3 h-3" />
            </a>
          </CardContent>
        </Card>
        <Link to={`/invoice/${id}`}><Button className="w-full mt-4">Back to Invoice</Button></Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
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
          <TabsTrigger value="x402" className="text-xs flex-1 gap-1"><Zap className="w-3 h-3" /> x402</TabsTrigger>
          <TabsTrigger value="mpp" className="text-xs flex-1 gap-1"><Users className="w-3 h-3" /> MPP</TabsTrigger>
          <TabsTrigger value="agent" className="text-xs flex-1 gap-1"><Bot className="w-3 h-3" /> Agent</TabsTrigger>
        </TabsList>

        {/* x402 Payment */}
        <TabsContent value="x402">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Zap className="w-4 h-4 text-yellow-500" /> x402 Protocol Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">Pay using the x402 HTTP payment protocol on Optimism Sepolia testnet.</p>
              <div className="bg-muted/50 rounded-xl p-3 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Invoice Amount</span><span className="font-bold">{formatCurrency(invoice.grand_total, invoice.currency)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Network Fee</span><span>0.001 ETH</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Network</span><Badge variant="outline" className="text-[10px]">Optimism Sepolia</Badge></div>
              </div>
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-start gap-2">
                <Wallet className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
                <p className="text-xs text-yellow-700">Demo Mode: Payment will be simulated on testnet with a generated transaction hash.</p>
              </div>
              <Button className="w-full h-12 text-sm font-semibold" onClick={handleX402Payment} disabled={isProcessing || invoice.status === 'paid'}>
                {isProcessing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Processing...</> : 'Pay Now'}
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
                    {m.txHash && <p className="text-[10px] font-mono text-muted-foreground">TX: {m.txHash.slice(0, 20)}...</p>}
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

        {/* Agent ERC-8004 */}
        <TabsContent value="agent">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4 text-purple-500" /> ERC-8004 Agent Settlement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {delegation ? (
                <>
                  <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-purple-600" />
                      <span className="text-xs font-semibold text-purple-700">Active Delegation</span>
                    </div>
                    <div className="text-xs space-y-1 text-purple-600">
                      <p>Max Amount: ₹{delegation.maxAmount?.toLocaleString()}</p>
                      <p>Expires: {new Date(delegation.expiry).toLocaleDateString()}</p>
                      <p className="font-mono text-[10px]">Agent: {delegation.agentAddress?.slice(0, 14)}...</p>
                    </div>
                  </div>
                  <Button className="w-full h-12 text-sm font-semibold bg-purple-600 hover:bg-purple-700" onClick={handleAgentSettle} disabled={isProcessing || invoice.status === 'paid'}>
                    {isProcessing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Agent Settling...</> : <><Bot className="w-4 h-4 mr-2" /> Run Agent Settlement</>}
                  </Button>
                  <Button variant="outline" size="sm" className="w-full text-xs text-destructive" onClick={revokeDelegation}>Revoke Delegation</Button>
                </>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">Set up an AI agent to autonomously settle invoices on your behalf (ERC-8004 delegation).</p>
                  <div>
                    <Label className="text-xs">Max Amount (₹)</Label>
                    <Input type="number" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} className="mt-1 h-9 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Expiry (days)</Label>
                    <Input type="number" value={expiryDays} onChange={e => setExpiryDays(e.target.value)} className="mt-1 h-9 text-sm" />
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
