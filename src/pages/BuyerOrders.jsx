import React, { useState } from 'react';
import { db } from '@/services/db';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Package, ArrowRight, Download, Clock, FileText, MessageSquare, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { generateInvoicePDF } from '@/lib/pdfGenerator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function BuyerOrders() {
  const [tab, setTab] = useState('all');

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['buyer-invoices'],
    queryFn: () => db.entities.Invoice.list('-created_date', 100),
  });

  const draftInvoices = invoices.filter(inv => inv.status === 'draft' || inv.status === 'pending');
  const completedOrders = invoices.filter(inv => inv.status === 'paid' || inv.status === 'validated');

  const displayedInvoices = tab === 'drafts' 
    ? draftInvoices 
    : tab === 'completed' 
      ? completedOrders 
      : invoices;

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold font-heading text-gray-900">My Orders & Invoices</h2>
          <p className="text-xs md:text-sm text-gray-500 mt-0.5">
            Review invoices drafted to you, download receipts, and settle payments.
          </p>
        </div>
        <Link to="/buyer" className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1.5 self-start sm:self-auto">
          Talk to AI Sales Agent <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between">
        <Tabs value={tab} onValueChange={setTab} className="w-full sm:w-auto">
          <TabsList className="bg-gray-100 p-1 rounded-xl">
            <TabsTrigger value="all" className="text-xs px-3.5 py-1.5 data-[state=active]:bg-white data-[state=active]:shadow-sm">
              All ({invoices.length})
            </TabsTrigger>
            <TabsTrigger value="drafts" className="text-xs px-3.5 py-1.5 data-[state=active]:bg-white data-[state=active]:shadow-sm">
              Pending Drafts ({draftInvoices.length})
            </TabsTrigger>
            <TabsTrigger value="completed" className="text-xs px-3.5 py-1.5 data-[state=active]:bg-white data-[state=active]:shadow-sm">
              Paid Orders ({completedOrders.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-500 text-sm">Loading orders and invoices...</div>
      ) : displayedInvoices.length === 0 ? (
        <Card className="border-dashed border-gray-200">
          <CardContent className="flex flex-col items-center justify-center py-14 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              {tab === 'drafts' ? <Clock className="w-8 h-8 text-gray-400" /> : <Package className="w-8 h-8 text-gray-400" />}
            </div>
            <h3 className="text-lg font-bold text-gray-900">
              {tab === 'drafts' ? 'No pending drafts' : tab === 'completed' ? 'No completed orders yet' : 'No records found'}
            </h3>
            <p className="text-sm text-gray-500 max-w-sm mt-1 mb-6">
              {tab === 'drafts'
                ? 'You do not have any pending invoice proposals drafted at this time.'
                : "You haven't made any completed purchases yet. Talk to our AI Agent to find the right software and negotiate deals."}
            </p>
            <Link to="/buyer" className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
              Chat with Agent
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {displayedInvoices.map(order => {
            const isDraft = order.status === 'draft';
            return (
              <Card key={order.id} className="overflow-hidden hover:shadow-md transition-shadow border-gray-200">
                <CardContent className="p-0">
                  <div className="flex flex-col md:flex-row border-b border-gray-100">
                    <div className="p-4 md:p-6 flex-1 flex items-start gap-4">
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${isDraft ? 'bg-amber-50 text-amber-600' : 'bg-indigo-50 text-indigo-600'}`}>
                        {isDraft ? <Clock className="w-6 h-6" /> : <Package className="w-6 h-6" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between w-full gap-2">
                          <div>
                            <h4 className="font-semibold text-gray-900 text-lg tracking-tight">
                              {isDraft ? 'Invoice' : 'Order'}{' '}
                              <span className="font-mono text-gray-600 ml-1">{order.invoice_number}</span>
                            </h4>
                            <p className="text-xs text-gray-500 mt-1">
                              {order.institution_name ? `From: ${order.institution_name} • ` : ''}
                              {isDraft ? 'Drafted on ' : 'Placed on '}
                              {order.invoice_date || (order.created_date ? new Date(order.created_date).toLocaleDateString() : '')}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          {order.status === 'draft' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                              <Clock className="w-3 h-3" /> Draft • Awaiting Settlement
                            </span>
                          )}
                          {order.status === 'pending' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
                              <Clock className="w-3 h-3" /> Pending
                            </span>
                          )}
                          {order.status === 'paid' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 border border-green-200">
                              <CheckCircle2 className="w-3 h-3" /> Paid
                            </span>
                          )}
                          {order.status === 'validated' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-200">
                              <CheckCircle2 className="w-3 h-3" /> Validated
                            </span>
                          )}
                          {order.status === 'anomaly' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
                              <Clock className="w-3 h-3" /> Anomaly
                            </span>
                          )}
                          {order.is_ai_upsell && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-100 text-purple-700">
                              Campaign Offer
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="p-4 md:p-6 bg-gray-50/80 flex md:flex-col items-center md:items-end justify-between md:justify-center md:w-56 shrink-0 border-t md:border-t-0 md:border-l border-gray-100">
                      <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">Total Amount</span>
                      <span className="text-xl font-bold text-gray-900 font-mono mt-0.5">
                        ₹{(Number(order.grand_total) || 0).toLocaleString('en-IN')}
                      </span>
                    </div>
                  </div>

                  {/* Line Items */}
                  {order.line_items && order.line_items.length > 0 && (
                    <div className="p-4 bg-white border-b border-gray-100">
                      <h5 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2.5">Items Included</h5>
                      <ul className="space-y-1.5">
                        {order.line_items.map((item, idx) => (
                          <li key={idx} className="flex justify-between text-sm">
                            <span className="text-gray-700 flex items-center gap-2">
                              <span className={`w-1.5 h-1.5 rounded-full ${isDraft ? 'bg-amber-400' : 'bg-indigo-400'}`} />
                              {item.description || item.name}
                            </span>
                            <span className="text-gray-600 font-medium whitespace-nowrap ml-4 text-xs font-mono">
                              {item.quantity} × ₹{(Number(item.unit_price) || 0).toLocaleString('en-IN')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Actions Toolbar */}
                  <div className="px-4 py-3 bg-gray-50/50 flex items-center justify-end gap-2 flex-wrap">
                    <Link to={`/invoice/${order.id}`}>
                      <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 border-gray-200">
                        <FileText className="w-3.5 h-3.5" /> View Invoice
                      </Button>
                    </Link>
                    <Button variant="outline" size="sm" onClick={() => generateInvoicePDF(order)} className="h-8 text-xs gap-1.5 border-gray-200">
                      <Download className="w-3.5 h-3.5" /> Download PDF
                    </Button>
                    {isDraft && (
                      <Link to="/buyer">
                        <Button size="sm" className="h-8 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white">
                          <MessageSquare className="w-3.5 h-3.5" /> Discuss in Chat
                        </Button>
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
