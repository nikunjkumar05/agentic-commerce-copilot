import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Loader2, Megaphone, CheckCircle2, PlayCircle, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

export default function Campaigns() {
  const queryClient = useQueryClient();
  const [isNew, setIsNew] = useState(false);
  const [editId, setEditId] = useState(null);
  const [formData, setFormData] = useState({ name: '', upsell_product_ids: [], target_statuses: ['validated'] });

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/campaigns', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to fetch campaigns');
      return res.json();
    }
  });

  const { data: catalogData } = useQuery({
    queryKey: ['catalog'],
    queryFn: async () => {
      const res = await fetch('/api/catalog');
      return res.json();
    }
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const token = localStorage.getItem('app_access_token');
      const payload = { 
        ...data, 
        upsell_product_id: data.upsell_product_ids.join(','),
        target_status: data.target_statuses.join(',')
      };
      
      const res = await fetch(editId ? `/api/campaigns/${editId}` : '/api/campaigns', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to save');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setIsNew(false);
      setEditId(null);
      setFormData({ name: '', upsell_product_ids: [], target_statuses: ['validated'] });
      toast.success(`Campaign ${editId ? 'updated' : 'created'}`);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/campaigns/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Campaign deleted');
    }
  });

  const launchMutation = useMutation({
    mutationFn: async (id) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/campaigns/${id}/launch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to launch');
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(`Launched! Generated ${data.drafts_created} invoice drafts.`);
    }
  });

  const revokeMutation = useMutation({
    mutationFn: async (id) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/campaigns/${id}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to revoke');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success('Campaign revoked and drafts deleted');
    }
  });

  const openNewForm = () => {
    setEditId(null);
    setFormData({ name: '', upsell_product_ids: [], target_statuses: ['validated'] });
    setIsNew(true);
  };

  const openEditForm = (camp) => {
    setEditId(camp.id);
    setFormData({ 
      name: camp.name, 
      upsell_product_ids: camp.upsell_product_id ? camp.upsell_product_id.split(',') : [], 
      target_statuses: camp.target_status ? camp.target_status.split(',') : [] 
    });
    setIsNew(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4 pb-24 w-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-indigo-500" /> 
          Campaign Orchestrator
        </h2>
        <Button size="sm" onClick={openNewForm}>+ New Campaign</Button>
      </div>

      {isNew && (
        <Card className="border-indigo-100 bg-indigo-50/50 shadow-md">
          <CardContent className="pt-4 space-y-3">
            <div>
              <Label className="text-xs">Campaign Name</Label>
              <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="mt-1 h-9 text-sm" placeholder="e.g. Q4 Security Push" />
            </div>
            <div>
              <Label className="text-xs">Products to Upsell</Label>
              <div className="mt-1 max-h-48 overflow-y-auto border rounded-md bg-white p-2 space-y-2">
                {catalogData?.map(p => (
                  <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1 rounded">
                    <input 
                      type="checkbox" 
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                      checked={formData.upsell_product_ids.includes(p.id)}
                      onChange={(e) => {
                        const newIds = e.target.checked 
                          ? [...formData.upsell_product_ids, p.id]
                          : formData.upsell_product_ids.filter(id => id !== p.id);
                        setFormData({ ...formData, upsell_product_ids: newIds });
                      }}
                    />
                    <span>{p.name} <span className="text-muted-foreground">(₹{p.price})</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Target Audience</Label>
              <div className="mt-1 border rounded-md bg-white p-2 space-y-2">
                {[
                  { id: 'validated', label: 'Customers with Validated Invoices' },
                  { id: 'paid', label: 'Customers with Paid Invoices' },
                  { id: 'draft', label: 'Customers with Draft Invoices' }
                ].map(status => (
                  <label key={status.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1 rounded">
                    <input 
                      type="checkbox" 
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                      checked={formData.target_statuses.includes(status.id)}
                      onChange={(e) => {
                        const newStatuses = e.target.checked 
                          ? [...formData.target_statuses, status.id]
                          : formData.target_statuses.filter(id => id !== status.id);
                        setFormData({ ...formData, target_statuses: newStatuses });
                      }}
                    />
                    <span>{status.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={() => saveMutation.mutate(formData)} disabled={!formData.name || formData.upsell_product_ids.length === 0 || formData.target_statuses.length === 0 || saveMutation.isLoading}>
                {saveMutation.isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />} {editId ? 'Save Changes' : 'Save Draft'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setIsNew(false); setEditId(null); }}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : campaigns.length === 0 ? (
        <div className="text-center p-8 border border-dashed rounded-xl text-muted-foreground text-sm">
          No campaigns yet. Launch one to automatically generate AI upsell invoices!
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(camp => {
            const productNames = camp.upsell_product_id.split(',').map(id => {
              const p = catalogData?.find(c => c.id === id);
              return p ? p.name : id;
            }).join(', ');
            
            return (
              <Card key={camp.id} className="overflow-hidden">
                <CardHeader className="pb-2 bg-slate-50/50">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-sm font-semibold">{camp.name}</CardTitle>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${camp.status === 'draft' ? 'bg-gray-100 text-gray-700' : 'bg-green-100 text-green-700 border-green-200'}`}>
                          {camp.status.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                        <span className="font-medium text-gray-700">Targeting:</span> {camp.target_status} <br/>
                        <span className="font-medium text-gray-700">Products:</span> {productNames}
                      </p>
                    </div>
                    {camp.status === 'draft' && (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-500 hover:text-indigo-600" onClick={() => openEditForm(camp)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-500 hover:text-red-600" onClick={() => {
                          if (confirm('Are you sure you want to delete this draft campaign?')) {
                            deleteMutation.mutate(camp.id);
                          }
                        }}>
                          {deleteMutation.isLoading && deleteMutation.variables === camp.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-3">
                  <div className="mb-4 bg-white p-3 rounded-xl border">
                    <h4 className="text-[10px] uppercase font-bold text-muted-foreground mb-3 tracking-wider">Campaign Funnel</h4>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center text-xs">
                        <div className="w-24 text-right pr-3 text-muted-foreground">Generated</div>
                        <div className="flex-1 bg-indigo-50 h-6 rounded-r flex items-center relative overflow-hidden">
                          <div className="absolute left-0 top-0 bottom-0 bg-indigo-100 w-full"></div>
                          <span className="relative z-10 font-mono font-bold text-indigo-700 ml-2">{camp.sent}</span>
                        </div>
                      </div>
                      <div className="flex items-center text-xs">
                        <div className="w-24 text-right pr-3 text-muted-foreground">Accepted</div>
                        <div className="flex-1 h-6 flex items-center relative">
                          <div className="absolute left-0 top-0 bottom-0 bg-indigo-200 rounded-r transition-all" style={{ width: camp.sent ? `${Math.max((camp.accepted / camp.sent) * 100, 5)}%` : '0%' }}></div>
                          <span className="relative z-10 font-mono font-bold text-indigo-800 ml-2">{camp.accepted}</span>
                        </div>
                      </div>
                      <div className="flex items-center text-xs">
                        <div className="w-24 text-right pr-3 font-medium text-green-700">Paid (ROI)</div>
                        <div className="flex-1 h-6 flex items-center relative">
                          <div className="absolute left-0 top-0 bottom-0 bg-green-200 rounded-r transition-all" style={{ width: camp.sent ? `${Math.max((camp.paid / camp.sent) * 100, 5)}%` : '0%' }}></div>
                          <span className="relative z-10 font-mono font-bold text-green-800 ml-2">{camp.paid}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {camp.status === 'draft' && (
                    <Button size="sm" className="w-full gap-2 shadow-sm" onClick={() => launchMutation.mutate(camp.id)} disabled={launchMutation.isLoading}>
                      {launchMutation.isLoading && launchMutation.variables === camp.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                      Launch Campaign
                    </Button>
                  )}
                  {camp.status === 'launched' && (
                    <Button size="sm" variant="destructive" className="w-full gap-2 shadow-sm" onClick={() => {
                      if (confirm('Revoke this campaign? Unaccepted draft invoices will be deleted and this campaign will revert to a draft.')) {
                        revokeMutation.mutate(camp.id);
                      }
                    }} disabled={revokeMutation.isLoading}>
                      {revokeMutation.isLoading && revokeMutation.variables === camp.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                      Revoke Campaign
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
