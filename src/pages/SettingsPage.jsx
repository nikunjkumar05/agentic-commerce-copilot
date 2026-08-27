import { db } from '@/services/db';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Building2, Key, Wallet, Bot, Database as DatabaseIcon, Info, Shield, LogOut, Trash2, Download, Upload, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';

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

      {/* Wallet & Blockchain */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Wallet className="w-4 h-4" /> Blockchain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-start gap-2">
            <Info className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
            <p className="text-xs text-yellow-700">Demo Mode: All blockchain interactions are simulated on Optimism Sepolia testnet.</p>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Network</span>
            <Badge variant="outline" className="text-[10px] font-mono">Optimism Sepolia</Badge>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">PPT Token</span>
            <Badge variant="outline" className="text-[10px] font-mono">ERC-20</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Agent Delegation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" /> Agent Delegation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {delegationMax > 0 ? (
            <>
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-1.5 text-xs text-purple-700">
                <div className="flex items-center gap-1.5 font-semibold"><Shield className="w-3.5 h-3.5" /> Active Delegation</div>
                <p>Max Vault Limit: ₹{delegationMax.toLocaleString()}</p>
                <p>Enforced by: Secure Backend DB</p>
              </div>
              <Button variant="destructive" size="sm" className="text-xs" onClick={revokeDelegation}>Revoke Delegation</Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No active delegation. Set up from the payment page.</p>
          )}
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
          <p className="font-semibold text-foreground">GovtInvoice Co-Pilot v1.0</p>
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
