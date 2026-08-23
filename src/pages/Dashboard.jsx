import { db } from '@/services/db';

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, FileText, IndianRupee, Clock, Database } from 'lucide-react';
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

  const filtered = filter === 'all'
    ? invoices
    : invoices.filter(inv => inv.status === filter);

  const totalValue = invoices.reduce((sum, inv) => sum + (inv.grand_total || 0), 0);
  const pendingCount = invoices.filter(i => ['draft', 'validated'].includes(i.status)).length;
  const storedCount = invoices.filter(i => i.cid).length;

  return (
    <motion.div initial="initial" animate="animate" variants={stagger} className="px-4 pb-24 space-y-5">
      {/* Metrics */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 gap-3">
        <MetricCard icon={FileText} label="Total Invoices" value={invoices.length} variant="default" />
        <MetricCard icon={IndianRupee} label="Total Value" value={`₹${(totalValue / 100000).toFixed(1)}L`} sublabel="All invoices" variant="success" />
        <MetricCard icon={Clock} label="Pending" value={pendingCount} sublabel="Awaiting action" variant="warning" />
        <MetricCard icon={Database} label="On IPFS" value={storedCount} sublabel="Decentralized" variant="info" />
      </motion.div>

      {/* New Invoice CTA */}
      <motion.div variants={fadeUp}>
        <Link to="/invoice/new">
          <Button className="w-full h-13 text-sm font-semibold rounded-2xl bg-accent hover:bg-accent/90 text-accent-foreground shadow-lg shadow-accent/20 gap-2 border-0">
            <Plus className="w-5 h-5" />
            Create New Invoice with AI
          </Button>
        </Link>
      </motion.div>

      {/* Recent Invoices Section */}
      <motion.div variants={fadeUp} className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-heading font-bold tracking-tight">Recent Invoices</h2>
          <span className="text-[11px] text-muted-foreground font-mono">{filtered.length} invoices</span>
        </div>
        <div className="rule" />
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList className="w-full h-9 bg-muted/60 rounded-xl p-0.5">
            <TabsTrigger value="all" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">All</TabsTrigger>
            <TabsTrigger value="draft" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Draft</TabsTrigger>
            <TabsTrigger value="validated" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Valid</TabsTrigger>
            <TabsTrigger value="paid" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Paid</TabsTrigger>
            <TabsTrigger value="anomaly" className="text-xs flex-1 data-[state=active]:bg-card data-[state=active]:shadow-sm">Anomaly</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="space-y-2">
          {isLoading ? (
            Array(4).fill(0).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-2xl" />
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <Stamp text="EMPTY" variant="navy" className="w-16 h-16 mx-auto opacity-40" />
              <p className="text-sm font-medium text-muted-foreground">No invoices yet</p>
              <p className="text-xs text-muted-foreground/60">Create your first invoice with AI to get started</p>
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
    </motion.div>
  );
}
