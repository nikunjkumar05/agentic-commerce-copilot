import { db } from '@/services/db';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Building2, Bot, Database as DatabaseIcon, Shield, LogOut, Download, ArrowRight } from 'lucide-react';

export default function SettingsPage() {
  const navigate = useNavigate();
  
  const [profile, setProfile] = useState(() => {
    const stored = localStorage.getItem('institution_profile');
    return stored ? JSON.parse(stored) : { name: '', address: '', gst: '' };
  });

  // Fetch user profile from backend to get the secure delegation limit
  const { data: userProfile, refetch: refetchProfile } = useQuery({
    queryKey: ['user-profile'],
    queryFn: async () => {
      const token = localStorage.getItem('app_access_token');
      if (!token) return null;
      const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
  });

  const delegationMax = userProfile?.agent_delegation_max || 0;
  const dailyLimit = userProfile?.agent_daily_limit || 0;
  const dailySpent = userProfile?.agent_daily_spent || 0;
  const hasMandate = Boolean(userProfile?.razorpay_token_id);

  const { data: invoices = [] } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => db.entities.Invoice.list('-created_date', 200),
  });

  const saveProfile = () => {
    localStorage.setItem('institution_profile', JSON.stringify(profile));
    toast.success('Profile saved');
  };

  const exportInvoices = () => {
    const blob = new Blob([JSON.stringify(invoices, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoices-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${invoices.length} invoices`);
  };

  const revokeDelegation = async () => {
    try {
      const token = localStorage.getItem('app_access_token');
      await fetch('/api/user/delegation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ maxAmount: 0 })
      });
      localStorage.removeItem('agent_delegation'); // Cleanup legacy data
      await refetchProfile();
      toast.success('Delegation revoked securely');
    } catch (err) {
      toast.error('Failed to revoke delegation');
    }
  };

  const handleLogout = () => {
    db.auth.logout('/login');
  };

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4 pb-24">
      <h2 className="text-lg font-bold">Settings</h2>

      {/* Institution Profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Building2 className="w-4 h-4" /> Institution Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Institution Name</Label>
            <Input value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} className="mt-1 h-9 text-sm" placeholder="e.g. NSUT Delhi" />
          </div>
          <div>
            <Label className="text-xs">Address</Label>
            <Input value={profile.address} onChange={e => setProfile({ ...profile, address: e.target.value })} className="mt-1 h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs">GST Number</Label>
            <Input value={profile.gst} onChange={e => setProfile({ ...profile, gst: e.target.value })} className="mt-1 h-9 text-sm font-mono" placeholder="07AAACN0372J1ZB" />
          </div>
          <Button size="sm" onClick={saveProfile}>Save Profile</Button>
        </CardContent>
      </Card>

      {/* Agent Delegation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" /> Agent Delegation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">Max Per-Transaction Limit (₹)</Label>
                <Input
                  type="number"
                  defaultValue={delegationMax}
                  id="delegationInput"
                  className="mt-1 h-9 text-sm"
                  placeholder="e.g. 10000"
                />
              </div>
              <Button size="sm" onClick={async () => {
                const val = parseFloat(document.getElementById('delegationInput').value) || 0;
                try {
                  await fetch('/api/user/delegation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('app_access_token')}` },
                    body: JSON.stringify({ maxAmount: val })
                  });
                  await refetchProfile();
                  toast.success(`Per-transaction cap updated to ₹${val}`);
                } catch(e) {
                  toast.error('Failed to update limit');
                }
              }}>Save</Button>
            </div>

            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">Daily Autonomous Spend Limit (₹)</Label>
                <Input
                  type="number"
                  defaultValue={dailyLimit}
                  id="dailyLimitInput"
                  className="mt-1 h-9 text-sm"
                  placeholder="e.g. 50000"
                />
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                const val = parseFloat(document.getElementById('dailyLimitInput').value) || 0;
                try {
                  await fetch('/api/user/delegation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('app_access_token')}` },
                    body: JSON.stringify({ maxAmount: delegationMax, dailyLimit: val })
                  });
                  await refetchProfile();
                  toast.success(`Daily limit updated to ₹${val}`);
                } catch(e) {
                  toast.error('Failed to update daily limit');
                }
              }}>Save</Button>
            </div>

            {dailyLimit > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                  <span>Today: ₹{dailySpent.toLocaleString('en-IN')} spent</span>
                  <span>of ₹{dailyLimit.toLocaleString('en-IN')}</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${dailySpent / dailyLimit > 0.8 ? 'bg-red-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(100, (dailySpent / dailyLimit) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {delegationMax > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1.5 text-xs text-blue-700">
                <div className="flex items-center gap-1.5 font-semibold"><Shield className="w-3.5 h-3.5" /> Active Delegation</div>
                <p>Per-transaction cap: ₹{delegationMax.toLocaleString('en-IN')}</p>
                <p>Daily cap: ₹{Number(dailyLimit || 0).toLocaleString('en-IN')}</p>
                <p>Enforced by: Secure Backend DB</p>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" className="text-xs flex-1" onClick={async () => {
                const customerId = prompt('Razorpay Customer ID (cust_…) from a test-mode checkout:');
                const tokenId = prompt('Razorpay Token ID (token_…) for the saved card:');
                if (!customerId || !tokenId) {
                  toast.error('Both customer_id and token_id are required.');
                  return;
                }
                try {
                  const res = await fetch('/api/user/razorpay-mandate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('app_access_token')}` },
                    body: JSON.stringify({ razorpay_customer_id: customerId, razorpay_token_id: tokenId })
                  });
                  if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.message || 'Binding failed');
                  }
                  await refetchProfile();
                  toast.success('Mandate bound. Autonomous S2S now armed.');
                } catch (e) {
                  toast.error(e.message || 'Failed to bind mandate');
                }
              }}>
                {hasMandate ? 'Re-bind Mandate' : 'Bind Razorpay Mandate'}
              </Button>
              {hasMandate && (
                <Button variant="ghost" size="sm" className="text-xs" onClick={async () => {
                  if (!confirm('Revoke the bound Razorpay mandate token?')) return;
                  try {
                    await fetch('/api/user/razorpay-mandate', {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${localStorage.getItem('app_access_token')}` }
                    });
                    await refetchProfile();
                    toast.success('Mandate revoked.');
                  } catch (e) {
                    toast.error('Failed to revoke mandate');
                  }
                }}>Revoke Mandate</Button>
              )}
              {delegationMax > 0 && (
                <Button variant="destructive" size="sm" className="text-xs" onClick={revokeDelegation}>Revoke Cap</Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agent Audit Log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><DatabaseIcon className="w-4 h-4" /> Agent Audit Log</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">All autonomous agent decisions are recorded in an immutable hash chain.</p>
            <Button onClick={() => navigate('/audit')} className="w-full gap-2">
              View Cryptographic Audit Trail <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Data Management */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Download className="w-4 h-4" /> Data Management</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button variant="outline" size="sm" className="w-full text-xs gap-1" onClick={exportInvoices}>
            <Download className="w-3 h-3" /> Export All Invoices (JSON)
          </Button>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">AgentPay Gateway v1.0</p>
          <p>Nikunj × RazorPay | Agentic Web3 Billing System</p>
          <p>AI-powered invoice generation, validation, decentralized storage, and agentic payments.</p>
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full text-destructive gap-2" onClick={handleLogout}>
        <LogOut className="w-4 h-4" /> Sign Out
      </Button>
    </div>
  );
}
