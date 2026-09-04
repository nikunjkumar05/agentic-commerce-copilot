import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Plus, Trash2, Package, Tag, Sparkles, Loader2 } from 'lucide-react';

const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('app_access_token')}` });

function SellabilityPanel({ catalog }) {
  const queryClient = useQueryClient();
  const [showJsonLd, setShowJsonLd] = useState(false);
  const { data: score, isLoading } = useQuery({
    queryKey: ['sellability'],
    queryFn: async () => {
      const res = await fetch('/api/merchant/sellability', { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to load sellability score');
      return res.json();
    }
  });
  const { data: jsonLd } = useQuery({
    queryKey: ['sellability-jsonld'],
    enabled: showJsonLd,
    queryFn: async () => {
      const res = await fetch('/api/merchant/sellability/jsonld');
      if (!res.ok) throw new Error('Failed to load JSON-LD');
      return res.json();
    }
  });
  const fixMutation = useMutation({
    mutationFn: async () => {
      const missing = (catalog || []).filter((p) => !p.hsn_code).map((p) => ({ id: p.id, hsn_code: '998313' }));
      if (missing.length === 0) throw new Error('Nothing to auto-fix');
      const res = await fetch('/api/merchant/sellability/fix', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ updates: missing })
      });
      if (!res.ok) throw new Error('Auto-fix failed');
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sellability'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success(`Auto-fix applied: ${data.fixed} edited, ${data.hsn_defaulted} HSN defaulted. Score ${data.score}/100`);
    },
    onError: (e) => toast.error(e.message || 'Auto-fix failed')
  });
  const missingHsn = (catalog || []).filter((p) => !p.hsn_code).length;

  return (
    <Card className="border-emerald-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-600" /> AI-Sellability Score
          {!isLoading && score && (
            <span className="ml-auto font-mono text-2xl font-bold text-emerald-700">{score.score}<span className="text-sm text-muted-foreground">/100</span></span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Scanning catalog for AI-readiness...</p>
        ) : score ? (
          <>
            <p className="text-sm text-muted-foreground">{score.product_count} products scanned. {score.issues?.length || 0} need fixes.</p>
            {(score.issues || []).slice(0, 5).map((issue, i) => (
              <div key={i} className="text-sm bg-amber-500/10 border border-amber-500/30 rounded-md p-2">
                <p className="font-bold">{issue.name || issue.sku || 'Unnamed product'}</p>
                <ul className="list-disc ml-5 text-muted-foreground">{issue.fixes.map((f, j) => <li key={j}>{f}</li>)}</ul>
              </div>
            ))}
            {(score.questions || []).map((q, i) => <p key={i} className="text-sm text-blue-700">💬 {q}</p>)}
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={() => fixMutation.mutate()} disabled={fixMutation.isPending || missingHsn === 0}>
                {fixMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {missingHsn === 0 ? 'Catalog is AI-ready' : `Auto-fix ${missingHsn} missing HSN`}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowJsonLd((v) => !v)}>
                {showJsonLd ? 'Hide JSON-LD' : 'View JSON-LD (what AI buyers read)'}
              </Button>
            </div>
            {showJsonLd && (
              <pre className="text-[10px] font-mono bg-slate-900 text-slate-200 rounded-md p-3 max-h-64 overflow-auto">
                {jsonLd ? JSON.stringify(jsonLd, null, 2) : 'Loading...'}
              </pre>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function CatalogManager() {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', description: '', price: '', margin_floor: '' });

  const { data: catalog = [], isLoading } = useQuery({
    queryKey: ['catalog'],
    queryFn: async () => {
      const res = await fetch('/api/catalog');
      if (!res.ok) throw new Error('Failed to load catalog');
      return res.json();
    }
  });

  const addMutation = useMutation({
    mutationFn: async (newProduct) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(newProduct)
      });
      if (!res.ok) throw new Error('Failed to add product');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      setIsAdding(false);
      setFormData({ name: '', description: '', price: '', margin_floor: '' });
      toast.success('Product added successfully');
    },
    onError: () => toast.error('Failed to add product')
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/catalog/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete product');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Product deleted successfully');
    },
    onError: () => toast.error('Failed to delete product')
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name || !formData.price || !formData.margin_floor) {
      toast.error('Please fill all required fields');
      return;
    }
    addMutation.mutate({
      name: formData.name,
      description: formData.description,
      price: Number(formData.price),
      margin_floor: Number(formData.margin_floor)
    });
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading catalog...</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Catalog Manager</h2>
          <p className="text-muted-foreground">Manage your products. The AI Agent will read these prices dynamically.</p>
        </div>
        <Button onClick={() => setIsAdding(true)} disabled={isAdding}>
          <Plus className="w-4 h-4 mr-2" /> Add Product
        </Button>
      </div>

      {isAdding && (
        <Card className="border-indigo-200 shadow-sm animate-in fade-in zoom-in-95 duration-200">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-indigo-600" /> New Product
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Product Name <span className="text-red-500">*</span></label>
                  <Input 
                    value={formData.name} 
                    onChange={e => setFormData(f => ({ ...f, name: e.target.value }))} 
                    placeholder="e.g. Enterprise SLA" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Input 
                    value={formData.description} 
                    onChange={e => setFormData(f => ({ ...f, description: e.target.value }))} 
                    placeholder="Brief details for the AI to pitch" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Retail Price (₹) <span className="text-red-500">*</span></label>
                  <Input 
                    type="number"
                    value={formData.price} 
                    onChange={e => setFormData(f => ({ ...f, price: e.target.value }))} 
                    placeholder="0" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Margin Floor (₹) <span className="text-red-500">*</span></label>
                  <Input 
                    type="number"
                    value={formData.margin_floor} 
                    onChange={e => setFormData(f => ({ ...f, margin_floor: e.target.value }))} 
                    placeholder="Minimum allowable price" 
                  />
                  <p className="text-[10px] text-muted-foreground">The AI will be flagged if it discounts below this floor.</p>
                </div>
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="ghost" type="button" onClick={() => setIsAdding(false)}>Cancel</Button>
                <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700">Save Product</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <SellabilityPanel catalog={catalog} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {catalog.map(product => (
          <Card key={product.id} className="group hover:border-indigo-300 transition-colors">
            <CardContent className="p-5 flex flex-col h-full">
              <div className="flex justify-between items-start mb-2">
                <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5 text-indigo-600" />
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-8 w-8 text-red-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => {
                    if(confirm('Delete this product?')) deleteMutation.mutate(product.id);
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              <h3 className="font-bold text-base leading-tight mt-1 line-clamp-2">{product.name}</h3>
              <p className="text-sm text-muted-foreground mt-2 line-clamp-3 flex-1">{product.description}</p>
              
              <div className="mt-4 pt-4 border-t grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Retail Price</p>
                  <p className="font-bold font-mono">₹{product.price.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">Margin Floor <Tag className="w-3 h-3 text-amber-500" /></p>
                  <p className="font-bold font-mono text-amber-600">₹{product.margin_floor.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {catalog.length === 0 && !isAdding && (
          <div className="col-span-full p-8 text-center border-2 border-dashed rounded-xl text-muted-foreground">
            No products in catalog. Add one to start selling via the AI Agent.
          </div>
        )}
      </div>
    </div>
  );
}
