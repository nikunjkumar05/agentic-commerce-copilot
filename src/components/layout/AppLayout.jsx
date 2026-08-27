import { Outlet, Link, useLocation } from 'react-router-dom';
import { Home, Plus, Database, Settings, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import Stamp from '@/components/Stamp';

const navItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/invoice/new', icon: Plus, label: 'New' },
  { path: '/agent-chat', icon: Bot, label: 'Agent' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function AppLayout() {
  const location = useLocation();
  const isDashboard = location.pathname === '/';

  return (
    <>
      <div className="min-h-screen flex flex-col max-w-4xl mx-auto bg-background/80 backdrop-blur-3xl md:border-x border-white/10 md:shadow-2xl relative">
        <header className={cn(
          'govt-header-gradient text-white',
          isDashboard ? 'px-4 pt-6 pb-8' : 'px-4 py-3',
          'relative overflow-hidden'
        )}>
          <div className="relative z-10">
            {isDashboard ? (
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-full bg-white/10 border border-white/15 flex items-center justify-center mb-4 backdrop-blur-sm">
                  <img src="/logo.png" alt="Logo" className="w-11 h-11 rounded-full object-contain" />
                </div>
                <h1 className="text-2xl font-heading font-bold tracking-tight">
                  GovtInvoice
                </h1>
                <p className="text-sm text-white/70 font-heading italic mt-0.5">Co-Pilot</p>
                <span className="inline-block mt-2 text-[10px] bg-white/10 px-3 py-1 rounded-full font-mono tracking-wider uppercase border border-white/10">
                  Nikunj × RazorPay
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center shrink-0 backdrop-blur-sm">
                  <img src="/logo.png" alt="Logo" className="w-6 h-6 rounded-full object-contain" />
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
          'flex-1 pb-24',
          isDashboard ? '-mt-4' : ''
        )}>
          <Outlet />
        </main>
      </div>

      <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-sm bg-black/40 backdrop-blur-xl border border-white/10 shadow-2xl rounded-3xl z-50 px-2 py-1 safe-area-bottom">
        <div className="flex items-center justify-around">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  "flex flex-col items-center gap-1 py-2 px-3 rounded-2xl transition-all duration-300 relative group",
                  isActive ? "text-white bg-white/10" : "text-white/50 hover:text-white/80 hover:bg-white/5"
                )}
              >
                <Icon className={cn("w-5 h-5 transition-transform duration-300", isActive ? "scale-110 stroke-[2.5]" : "group-hover:scale-110")} />
                <span className={cn("text-[9px] font-semibold transition-opacity duration-300", isActive ? "opacity-100" : "opacity-0 absolute -bottom-4 group-hover:opacity-100 group-hover:relative group-hover:-bottom-0")}>{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
