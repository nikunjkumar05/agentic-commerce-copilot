import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { User, Shield, Clock, Bot } from 'lucide-react';

export default function BuyerSettings() {
  const [profile, setProfile] = useState(() => {
    const stored = localStorage.getItem('buyer_profile');
    return stored ? JSON.parse(stored) : { name: 'AI Agent Buyer', email: 'buyer@example.com', address: 'New Delhi, India' };
  });

  // Fetch user profile from backend to get secure delegation limits
  const { data: userProfile, refetch: refetchProfile } = useQuery({
    queryKey: ['user-profile'],
    queryFn: async () => {
      const token = localStorage.getItem('app_access_token');
      if (!token) return null;
      const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });

  const delegationMax = Number(userProfile?.agent_delegation_max || 0);
  const dailyLimit = Number(userProfile?.agent_daily_limit || 50000);
  const dailySpent = Number(userProfile?.agent_daily_spent || 0);
  const hasMandate = Boolean(userProfile?.razorpay_token_id);

  const [perTxInput, setPerTxInput] = useState('');
  const [dailyInput, setDailyInput] = useState('');
  useEffect(() => {
    if (userProfile) {
      setPerTxInput(String(delegationMax || ''));
      setDailyInput(String(dailyLimit || ''));
    }
  }, [delegationMax, dailyLimit]);

  const saveProfile = () => {
    localStorage.setItem('buyer_profile', JSON.stringify(profile));
    toast.success('Your profile has been saved successfully');
  };

  const saveDelegation = async () => {
    const val = perTxInput === '' ? 0 : parseFloat(perTxInput) || 0;
    try {
      const token = localStorage.getItem('app_access_token');
      await fetch('/api/user/delegation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ maxAmount: val })
      });
      await refetchProfile();
      toast.success(`Per-transaction cap updated to ₹${val}`);
    } catch (e) {
      toast.error(e.message || 'Failed to update limit');
    }
  };

  const saveDailyLimit = async () => {
    const val = dailyInput === '' ? 0 : parseFloat(dailyInput) || 0;
    try {
      const token = localStorage.getItem('app_access_token');
      await fetch('/api/user/delegation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ dailyLimit: val })
      });
      await refetchProfile();
      toast.success(`Daily limit updated to ₹${val}`);
    } catch (e) {
      toast.error(e.message || 'Failed to update daily limit');
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold font-heading text-gray-900">Account Settings</h2>
        <p className="text-sm text-gray-500">Manage your personal information and billing details.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <User className="w-5 h-5 text-indigo-600" /> Personal Details
          </CardTitle>
          <CardDescription>This information will be used on your generated invoices.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input 
                id="name"
                value={profile.name} 
                onChange={e => setProfile({ ...profile, name: e.target.value })} 
                placeholder="e.g. John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input 
                id="email"
                type="email"
                value={profile.email} 
                onChange={e => setProfile({ ...profile, email: e.target.value })} 
                placeholder="john@example.com"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="address" className="flex items-center gap-2">
              Billing Address
            </Label>
            <Input 
              id="address"
              value={profile.address} 
              onChange={e => setProfile({ ...profile, address: e.target.value })} 
              placeholder="123 Main St, City, Country"
            />
          </div>
          <div className="pt-4">
            <Button onClick={saveProfile} className="bg-indigo-600 hover:bg-indigo-700 text-white w-full md:w-auto">
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Agent Delegation — per-buyer limits */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="w-5 h-5 text-emerald-600" /> Agent Delegation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">Max Per-Transaction Limit (₹)</Label>
                <Input
                  type="number"
                  value={perTxInput}
                  onChange={(e) => setPerTxInput(e.target.value)}
                  className="mt-1 h-9 text-sm"
                  placeholder="e.g. 10000"
                />
              </div>
              <Button size="sm" onClick={saveDelegation}>
                Save
              </Button>
            </div>

            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">Daily Autonomous Spend Limit (₹)</Label>
                <Input
                  type="number"
                  value={dailyInput}
                  onChange={(e) => setDailyInput(e.target.value)}
                  className="mt-1 h-9 text-sm"
                  placeholder="e.g. 50000"
                />
              </div>
              <Button size="sm" variant="outline" onClick={saveDailyLimit}>
                Save
              </Button>
            </div>
          </div>

          {dailyLimit > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>Today: ₹{dailySpent.toLocaleString('en-IN')} spent</span>
                <span>of ₹{dailyLimit.toLocaleString('en-IN')}</span>
              </div>
              <div
                className={`h-2 bg-muted rounded-full overflow-hidden`}
                style={{ width: `${Math.min(100, (dailySpent / dailyLimit) * 100)}%` }}
              />
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

          {hasMandate ? (
            <div>
              <p className="text-sm text-muted-foreground">Mandate: <span className="font-medium">Bound</span> — Autonomous S2S armed</p>
              <Button variant="ghost" size="sm" onClick={() => window.confirm('Revoke the bound Razorpay mandate token?') && fetch('/api/user/razorpay-mandate', { method: 'DELETE' })}>
                Revoke Mandate
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => {
              const customerId = prompt('Razorpay Customer ID (cust_…) from a test-mode checkout:');
              const tokenId = prompt('Razorpay Token ID (token_…) for the saved card:');
              if (!customerId || !tokenId) {
                toast.error('Both customer_id and token_id are required.');
                return;
              }
              fetch('/api/user/razorpay-mandate', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ razorpay_customer_id: customerId, razorpay_token_id: tokenId })
              }).then(async res => {
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}));
                  throw new Error(err.message || 'Binding failed');
                }
                await refetchProfile();
                toast.success('Mandate bound. Autonomous S2S now armed.');
              }).catch(e => toast.error(e.message || 'Failed to bind mandate'));
            }}>
              {hasMandate ? 'Re-bind Mandate' : 'Bind Razorpay Mandate'}
            </Button>
          )}

          {delegationMax > 0 && (
            <Button variant="destructive" size="sm" onClick={() => {
              if (!confirm('Revoke the per-transaction delegation cap?')) return;
              fetch('/api/user/delegation', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ maxAmount: 0 })
              }).then(() => {
                localStorage.removeItem('agent_delegation');
                refetchProfile();
                toast.success('Delegation revoked securely');
              }).catch(e => toast.error('Failed to revoke delegation'));
            }}>
              Revoke Cap
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
