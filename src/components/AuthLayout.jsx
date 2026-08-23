import Stamp from '@/components/Stamp';

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-accent/3" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 rounded-full bg-primary/3" />
      </div>
      <div className="w-full max-w-md relative">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            <Stamp text="SEETA" variant="navy" className="w-20 h-20" />
          </div>
          <h1 className="text-2xl font-heading font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-1.5 text-sm">{subtitle}</p>}
        </div>
        <div className="paper-card p-6">
          {children}
        </div>
        <div className="rule mt-6" />
        {footer && (
          <p className="text-center text-sm text-muted-foreground mt-4">{footer}</p>
        )}
      </div>
    </div>
  );
}
