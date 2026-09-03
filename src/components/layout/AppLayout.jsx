import React, { useState } from 'react';
import { Outlet, Link, useLocation, Navigate } from 'react-router-dom';
import { LayoutDashboard, Receipt, Activity, Store, Terminal, Fingerprint, SlidersHorizontal, Menu, LogOut, MessageSquare, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/AuthContext';

const merchantNavItems = [
  { path: '/merchant', icon: LayoutDashboard, label: 'Overview' },
  { path: '/merchant/invoice/new', icon: Receipt, label: 'Invoices' },
  { path: '/merchant/campaigns', icon: Activity, label: 'Campaigns' },
  { path: '/merchant/catalog', icon: Store, label: 'Catalog' },
  { path: '/merchant/transcripts', icon: Terminal, label: 'Transcripts' },
  { path: '/merchant/audit', icon: Fingerprint, label: 'Audit Trail' },
  { path: '/merchant/settings', icon: SlidersHorizontal, label: 'Settings' },
];

const buyerNavItems = [
  { path: '/buyer', icon: MessageSquare, label: 'Agent Chat' },
  { path: '/buyer/orders', icon: Package, label: 'Orders' },
  { path: '/buyer/settings', icon: SlidersHorizontal, label: 'Settings' },
];

export default function AppLayout() {
  const location = useLocation();
  const { logout, user } = useAuth();
  const [isExpanded, setIsExpanded] = useState(false);
  const isDashboard = location.pathname === '/merchant';
  
  // Use the authenticated user's role to permanently lock them into their persona's UI
  const isBuyerPortal = user?.role === 'buyer';
  
  if (isBuyerPortal && location.pathname.startsWith('/merchant')) {
    return <Navigate to="/buyer" replace />;
  }
  if (!isBuyerPortal && location.pathname.startsWith('/buyer')) {
    return <Navigate to="/merchant" replace />;
  }

  return (
    <div className={cn("min-h-screen bg-gray-50 flex flex-col md:pl-16")}>
      {/* Collapsible Sidebar */}
      <nav 
        className={cn(
          "fixed top-0 left-0 h-screen bg-slate-950 text-white shadow-2xl z-50 flex flex-col py-6 transition-all duration-300 border-r border-white/10",
          isExpanded ? "w-64" : "w-0 md:w-16 overflow-hidden md:overflow-visible"
        )}
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => setIsExpanded(false)}
      >
        <Link to={isBuyerPortal ? "/buyer" : "/merchant"} className="flex items-center px-4 mb-10 h-8 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded-full bg-white/10 border border-white/15 flex items-center justify-center shrink-0 overflow-hidden">
            <img src="/logo.png" alt="Logo" className="w-full h-full object-cover" />
          </div>
          <span className={cn(
            "ml-3 font-heading font-bold whitespace-nowrap transition-opacity duration-300",
            isExpanded ? "opacity-100" : "opacity-0"
          )}>
            AgentPay
          </span>
        </Link>
        
        <div className="flex flex-col gap-2 px-2 flex-1">
          {(isBuyerPortal ? buyerNavItems : merchantNavItems).map(({ path, icon: Icon, label }) => {
            const isActive = location.pathname === path || (path === '/merchant/invoice/new' && location.pathname.includes('/invoice'));
              return (
                <Link
                  key={path}
                  to={path}
                  className={cn(
                    "flex items-center gap-4 py-3 px-3 rounded-xl transition-all duration-300 w-full overflow-hidden",
                    isActive ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80 hover:bg-white/5"
                  )}
                >
                  <Icon strokeWidth={1.5} className={cn("w-5 h-5 shrink-0 transition-transform duration-300", isActive && "scale-110")} />
                  <span className={cn(
                    "text-sm font-medium whitespace-nowrap transition-all duration-300",
                    isExpanded ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4"
                  )}>
                    {label}
                  </span>
                </Link>
              );
            })}
          </div>

          <div className="px-2 mt-auto">
            <button
              onClick={logout}
              className="flex items-center gap-4 py-3 px-3 rounded-xl transition-all duration-300 w-full overflow-hidden text-red-400 hover:text-red-300 hover:bg-white/5"
            >
              <LogOut strokeWidth={1.5} className="w-5 h-5 shrink-0" />
              <span className={cn(
                "text-sm font-medium whitespace-nowrap transition-all duration-300",
                isExpanded ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4"
              )}>
                Logout
              </span>
            </button>
          </div>
        </nav>

      {/* Main Content Area */}
      <div className={cn(
        "flex-1 transition-all duration-300 min-h-screen flex flex-col relative w-full shadow-sm bg-background/80 backdrop-blur-3xl",
        location.pathname.includes('/transcripts') ? "" : "max-w-4xl mx-auto md:border-x border-gray-200"
      )}>
        
        {/* Mobile menu toggle */}
        <div className="md:hidden fixed bottom-6 right-6 z-50">
          <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="w-12 h-12 rounded-full bg-slate-950 text-white shadow-xl flex items-center justify-center"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>

        {!isBuyerPortal && (
          <header className={cn(
            'agentic-header-gradient',
            'text-white relative overflow-hidden shrink-0',
            isDashboard ? 'px-6 pt-8 pb-10' : 'px-6 py-4'
          )}>
            <div className="relative z-10 flex items-center justify-between">
              {isDashboard ? (
                <div className="flex flex-col items-center text-center w-full">
                  <div className="w-16 h-16 rounded-full bg-white/10 border border-white/15 flex items-center justify-center mb-4 backdrop-blur-sm shadow-xl overflow-hidden">
                    <img src="/logo.png" alt="Logo" className="w-full h-full object-cover" />
                  </div>
                  <h1 className="text-3xl font-heading font-bold tracking-tight">
                    AgentPay Gateway
                  </h1>
                  <p className="text-sm text-white/80 font-heading italic mt-1">Machine Checkout</p>
                  <span className="inline-block mt-3 text-[10px] bg-white/10 px-3 py-1 rounded-full font-mono tracking-wider uppercase border border-white/20">
                    Nikunj × RazorPay
                  </span>
                </div>
              ) : (
                <Link to="/merchant" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <div className="w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center shrink-0 backdrop-blur-sm">
                    <img src="/logo.svg" alt="Logo" className="w-5 h-5 rounded-full object-contain" />
                  </div>
                  <div>
                    <h1 className="text-sm font-heading font-bold leading-tight">Agentic Commerce</h1>
                    <p className="text-[9px] text-white/60 font-mono tracking-wider">Co-Pilot</p>
                  </div>
                </Link>
              )}
            </div>
            {isDashboard && (
              <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-[90%] h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
            )}
          </header>
        )}

        <main className={cn(
          'flex-1 flex flex-col',
          isBuyerPortal ? '' : 'pb-8',
          isDashboard ? '-mt-6 relative z-20' : ''
        )}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
