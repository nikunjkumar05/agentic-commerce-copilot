import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { User } from 'lucide-react';

export default function BuyerSettings() {
  const [profile, setProfile] = useState(() => {
    const stored = localStorage.getItem('buyer_profile');
    return stored ? JSON.parse(stored) : { name: 'AI Agent Buyer', email: 'buyer@example.com', address: 'New Delhi, India' };
  });

  const saveProfile = () => {
    localStorage.setItem('buyer_profile', JSON.stringify(profile));
    toast.success('Your profile has been saved successfully');
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
    </div>
  );
}
