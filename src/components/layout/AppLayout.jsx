import { Outlet, Link, useLocation } from 'react-router-dom';
import { Home, Plus, Database, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import Stamp from '@/components/Stamp';

const navItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/invoice/new', icon: Plus, label: 'New' },
  { path: '/storage', icon: Database, label: 'Storage' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function AppLayout() {
  const location = useLocation();
  const isDashboard = location.pathname === '/';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className={cn(
        'govt-header-gradient text-white',
        isDashboard ? 'px-4 pt-6 pb-8' : 'px-4 py-3',
        'relative overflow-hidden'
      )}>
        <div className="relative z-10">
          {isDashboard ? (
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-white/10 border border-white/15 flex items-center justify-center mb-4 backdrop-blur-sm">
                <img src="/seeta.jpeg" alt="SEETA" className="w-11 h-11 rounded-full object-contain" />
              </div>
              <h1 className="text-2xl font-heading font-bold tracking-tight">
                GovtInvoice
              </h1>
              <p className="text-sm text-white/70 font-heading italic mt-0.5">Co-Pilot</p>
              <span className="inline-block mt-2 text-[10px] bg-white/10 px-3 py-1 rounded-full font-mono tracking-wider uppercase border border-white/10">
                SEETA × NSUT × AIC
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center shrink-0 backdrop-blur-sm">
                <img src="/seeta.jpeg" alt="SEETA" className="w-6 h-6 rounded-full object-contain" />
              </div>
              <div>
                <h1 className="text-sm font-heading font-bold leading-tight">GovtInvoice</h1>
                <p className="text-[9px] text-white/60 font-mono tracking-wider">Co-Pilot</p>
              </div>
            </div>
          )}
        </div>
        {isDashboard && (
          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-[90%] h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        )}
      </header>

      <main className={cn(
        'flex-1',
        isDashboard ? '-mt-4' : ''
      )}>
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 px-2 safe-area-bottom">
        <div className="flex items-center justify-around max-w-lg mx-auto">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2 px-3 rounded-xl transition-all relative",
                  isActive ? "text-accent" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn("w-5 h-5", isActive && "stroke-[2.5]")} />
                <span className="text-[10px] font-semibold">{label}</span>
                {isActive && (
                  <div className="w-4 h-0.5 rounded-full bg-accent mt-0.5" />
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
