import { db } from '@/services/db';
import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogIn, Mail, Lock, Loader2, Store, User } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";

export default function Login() {
  const [searchParams, setSearchParams] = useSearchParams();
  const role = searchParams.get('role') || 'merchant';
  
  const setRole = (newRole) => {
    setSearchParams({ role: newRole });
  };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await db.auth.loginViaEmailPassword(email, password, role);
      window.location.href = "/";
    } catch (err) {
      setError(err.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    db.auth.loginWithProvider("google", "/");
  };

  const RoleIcon = role === 'buyer' ? User : Store;
  const roleTitle = role === 'buyer' ? 'Buyer Login' : 'Merchant Login';

  return (
    <AuthLayout
      icon={RoleIcon}
      title={roleTitle}
      subtitle={`Log in to your ${role} account`}
      footer={
        <>
          Don't have an account?{" "}
          <Link to={`/register?role=${role}`} className="text-accent font-medium hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <Tabs value={role} onValueChange={setRole} className="w-full mb-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="merchant" className="flex items-center gap-2"><Store className="w-4 h-4" /> Merchant</TabsTrigger>
          <TabsTrigger value="buyer" className="flex items-center gap-2"><User className="w-4 h-4" /> Buyer</TabsTrigger>
        </TabsList>
      </Tabs>

      <Button
        variant="outline"
        className="w-full h-12 text-sm font-medium mb-6 border-muted-foreground/20 hover:bg-muted/50"
        onClick={handleGoogle}
      >
        <GoogleIcon className="w-5 h-5 mr-2" />
        Continue with Google
      </Button>

      <div className="relative mb-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-3 text-muted-foreground font-medium">or</span>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-destructive/10 text-destructive text-sm border border-destructive/20">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email" className="text-xs font-medium">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10 h-12 bg-white"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password" className="text-xs font-medium">Password</Label>
            <Link to="/forgot-password" className="text-[11px] text-accent hover:underline font-medium">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-12 bg-white"
              required
            />
          </div>
        </div>
        
        <Link to="/demo">
          <Button type="button" variant="outline" className="w-full h-12 font-medium bg-primary/5 text-primary border-primary/20 hover:bg-primary/10 mb-3">
            Skip Login & Try Live Demo
          </Button>
        </Link>
        <Button type="submit" className="w-full h-12 font-medium bg-accent hover:bg-accent/90 text-accent-foreground border-0" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Logging in...
            </>
          ) : (
            "Log in"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
