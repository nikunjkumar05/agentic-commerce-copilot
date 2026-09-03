import { db } from '@/services/db';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Package, IndianRupee, ArrowRight, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { generateInvoicePDF } from '@/lib/pdfGenerator';

export default function BuyerOrders() {
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['buyer-invoices'],
    queryFn: () => db.entities.Invoice.list('-created_date', 50),
  });

  // Filter to show invoices that have been generated in this session
  // Since we share the DB for the demo, let's just show recent non-draft invoices
  // or invoices specifically for the buyer.
  const myOrders = invoices.filter(inv => inv.status === 'paid' || inv.status === 'validated');

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold font-heading text-gray-900">My Orders</h2>
        <Link to="/buyer" className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1">
          New Purchase <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">Loading orders...</div>
      ) : myOrders.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Package className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-900">No orders yet</h3>
            <p className="text-sm text-gray-500 max-w-sm mt-1 mb-6">
              You haven't made any purchases yet. Talk to our AI Agent to find the perfect software for your needs.
            </p>
            <Link to="/buyer" className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
              Chat with Agent
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {myOrders.map(order => (
            <Card key={order.id} className="overflow-hidden hover:shadow-md transition-shadow">
              <CardContent className="p-0">
                <div className="flex flex-col md:flex-row border-b border-gray-100">
                  <div className="p-4 md:p-6 flex-1 flex items-start gap-4">
                    <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center shrink-0">
                      <Package className="w-6 h-6 text-indigo-600" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-start justify-between w-full">
                        <div>
                          <h4 className="font-semibold text-gray-900 text-lg tracking-tight">
                            Order <span className="font-mono text-gray-600 ml-1">{order.invoice_number}</span>
                          </h4>
                          <p className="text-sm text-gray-500 mt-1">
                            Placed on {new Date(order.created_date).toLocaleDateString()}
                          </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => generateInvoicePDF(order)} className="hidden md:flex gap-2">
                          <Download className="w-4 h-4" /> Download PDF
                        </Button>
                      </div>
                      <div className="mt-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        {order.status.toUpperCase()}
                      </div>
                    </div>
                  </div>
                  <div className="p-4 md:p-6 bg-gray-50 flex md:flex-col items-center md:items-end justify-between md:justify-center md:w-48 shrink-0 border-t md:border-t-0 md:border-l border-gray-100">
                    <span className="text-sm text-gray-500 font-medium">Total Amount</span>
                    <span className="text-xl font-bold text-gray-900 flex items-center">
                      ₹{(order.grand_total || 0).toLocaleString('en-IN')}
                    </span>
                  </div>
                </div>
                {order.line_items && (
                  <div className="p-4 bg-white">
                    <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Items Included</h5>
                    <ul className="space-y-2">
                      {order.line_items.map((item, idx) => (
                        <li key={idx} className="flex justify-between text-sm">
                          <span className="text-gray-700 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                            {item.description}
                          </span>
                          <span className="text-gray-600 font-medium whitespace-nowrap ml-4">
                            {item.quantity} × ₹{item.unit_price?.toLocaleString('en-IN')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
