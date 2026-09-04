import { db } from '@/services/db';

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, IndianRupee, Clock, Bot, ArrowRight, Megaphone } from 'lucide-react';
import { motion } from 'framer-motion';
import MetricCard from '@/components/dashboard/MetricCard';
import InvoiceListItem from '@/components/dashboard/InvoiceListItem';
import Stamp from '@/components/Stamp';

const stagger = {
  animate: { transition: { staggerChildren: 0.06 } },
};

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] } },
};

export default function Dashboard() {
  const [filter, setFilter] = useState('all');

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => db.entities.Invoice.list('-created_date', 100),
  });

  // Upsell conversion funnel: suggested (audit trail) → created (invoice) → paid (revenue)
  const { data: auditLogs = [] } = useQuery({
    queryKey: ['audit-logs-funnel'],
    queryFn: () => db.entities.AgentAuditLog.list('-created_date', 200),
  });

  // Campaign lift (closed-loop): sent vs accepted vs paid from /api/campaigns
  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns-dashboard'],
    queryFn: async () => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/campaigns', { headers: { Authorization: `Bearer ${token}` } });
      return res.ok ? res.json() : [];
    },
  });

  const filtered = filter === 'all'
    ? invoices
    : invoices.filter(inv => inv.status === filter);

  // NOTE: grand_total may arrive as a string (NUMERIC columns) — Number() first,
  // otherwise `0 + "125.00"` concatenates and the total renders as NaN.
  const totalValue = invoices.reduce((sum, inv) => sum + (Number(inv.grand_total) || 0), 0);
  const pendingCount = invoices.filter(i => ['draft', 'validated', 'pending'].includes(i.status)).length;
  
  // Track AI Revenue Lift — only PAID invoices count as revenue (a draft or
  // anomaly invoice is not money earned). Agent-settled = paid via Razorpay
  // agent/webhook rails (payment_method set by the settlement endpoints).
  const paidInvoices = invoices.filter(i => i.status === 'paid');
  const aiRevenue = paidInvoices.filter(i => i.is_ai_upsell).reduce((sum, inv) => sum + (Number(inv.grand_total) || 0), 0);
  const agentSettledCount = paidInvoices.filter(i => (i.payment_method || '').startsWith('razorpay')).length;
  const paidValue = paidInvoices.reduce((sum, inv) => sum + (Number(inv.grand_total) || 0), 0);
  const aiRevenuePercentage = paidValue > 0 ? Math.round((aiRevenue / paidValue) * 100) : 0;
  // Funnel stages: the agent SUGGESTED (audit trail), the buyer ACCEPTED (invoice
  // exists with is_ai_upsell), and money was COLLECTED (that invoice is paid).
  const upsellSuggested = auditLogs.filter(l => l.action === 'upsell_suggested' || l.action === 'campaign_converted').length;
  const upsellAccepted = invoices.filter(i => i.is_ai_upsell).length;
  const upsellPaid = paidInvoices.filter(i => i.is_ai_upsell).length;

  // Closed-loop campaign metrics
  const campaignSent = campaigns.reduce((s, c) => s + (c.sent || 0), 0);
  const campaignAccepted = campaigns.reduce((s, c) => s + (c.accepted || 0), 0);
  const campaignPaid = campaigns.reduce((s, c) => s + (c.paid || 0), 0);
  const campaignConversion = campaignSent > 0 ? Math.round((campaignPaid / campaignSent) * 100) : 0;

  return (
    <motion.main initial="initial" animate="animate" variants={stagger} className="max-w-3xl mx-auto px-4 pb-32 pt-6 space-y-8">
      
      {/* Premium AI CTA Card */}
      <motion.div variants={fadeUp} className="relative group">
        <div className="absolute inset-0 bg-gradient-to-r from-accent via-blue-500 to-accent rounded-3xl blur opacity-25 group-hover:opacity-50 transition duration-500" />
        <Link to="/merchant/invoice/new" className="relative flex items-center justify-between gap-4 bg-card/80 backdrop-blur-xl border border-white/10 p-5 md:p-6 rounded-3xl shadow-xl hover:bg-card transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-accent/20 flex items-center justify-center shrink-0 border border-accent/20 overflow-hidden">
              <img src="/logo.png" alt="AgentPay" className="w-full h-full object-cover" />
            </div>
            <div className="text-left">
              <h3 className="text-lg md:text-xl font-bold font-heading text-foreground">AgentPay Gateway</h3>
              <p className="text-xs md:text-sm text-muted-foreground">Autonomously generate, cross-sell & settle</p>
            </div>
          </div>
          <div className="w-10 h-10 rounded-full bg-background/50 border border-border flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform">
            <ArrowRight className="w-5 h-5 text-foreground" />
          </div>
        </Link>
      </motion.div>

      {/* Metrics Grid */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard icon={FileText} label="Total Invoices" value={invoices.length} variant="default" />
        <MetricCard icon={IndianRupee} label="Total Value" value={`₹${(totalValue / 1000).toFixed(1)}k`} sublabel="All invoices" variant="success" />
        <MetricCard icon={Clock} label="Pending" value={pendingCount} sublabel="Awaiting action" variant="warning" />
        <MetricCard icon={Bot} label="AI Lift" value={`₹${(aiRevenue / 1000).toFixed(1)}k`} sublabel={`${aiRevenuePercentage}% of paid · ${agentSettledCount} agent-settled · funnel ${upsellSuggested}→${upsellAccepted}→${upsellPaid}`} variant="info" />
      </motion.div>

      {/* Campaign Lift row (closed-loop) */}
      {campaigns.length > 0 && (
        <motion.div variants={fadeUp} className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <MetricCard icon={Megaphone} label="Campaigns" value={campaigns.length} sublabel="Active + historical" variant="default" />
          <MetricCard icon={FileText} label="Campaigns Sent" value={campaignSent} sublabel={`${campaignAccepted} accepted`} variant="info" />
          <MetricCard icon={IndianRupee} label="Campaign Revenue" value={`₹${(paidInvoices.filter(i => i.campaign_id).reduce((s, i) => s + (Number(i.grand_total) || 0), 0) / 1000).toFixed(1)}k`} sublabel={`${campaignPaid} paid · ${campaignConversion}% conversion`} variant="success" />
        </motion.div>
      )}

      {/* Recent Invoices Section */}
      <motion.div variants={fadeUp} className="space-y-4 bg-card/40 backdrop-blur-md border border-border p-4 md:p-6 rounded-3xl shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-heading font-bold tracking-tight">Recent Activity</h2>
          <span className="text-[11px] text-muted-foreground font-mono bg-background px-2 py-1 rounded-md border border-border">{filtered.length} ledgers</span>
        </div>
        
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList className="w-full h-10 bg-background/50 rounded-xl p-1 border border-border">
            <TabsTrigger value="all" className="text-xs flex-1 rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">All</TabsTrigger>
            <TabsTrigger value="draft" className="text-xs flex-1 rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">Draft</TabsTrigger>
            <TabsTrigger value="validated" className="text-xs flex-1 rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">Valid</TabsTrigger>
            <TabsTrigger value="paid" className="text-xs flex-1 rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm">Paid</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="space-y-3 pt-2">
          {isLoading ? (
            Array(4).fill(0).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-2xl bg-muted/50" />
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <Stamp text="EMPTY" variant="navy" className="w-16 h-16 mx-auto opacity-40 grayscale" />
              <p className="text-sm font-medium text-muted-foreground">No ledgers found</p>
              <p className="text-xs text-muted-foreground/60">Initialize your first transaction with the AI Co-Pilot.</p>
            </div>
          ) : (
            filtered.map((invoice, i) => (
              <motion.div key={invoice.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.04 } }}>
                <InvoiceListItem invoice={invoice} />
              </motion.div>
            ))
          )}
        </div>
      </motion.div>
    </motion.main>
  );
}
