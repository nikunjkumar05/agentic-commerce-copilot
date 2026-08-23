import { cn } from '@/lib/utils';

const variants = {
  default: { border: 'border-primary/15', accent: 'bg-primary/10 text-primary', icon: 'text-primary' },
  success: { border: 'border-success/15', accent: 'bg-success/10 text-success', icon: 'text-success' },
  warning: { border: 'border-accent/20', accent: 'bg-accent/10 text-accent', icon: 'text-accent' },
  info: { border: 'border-primary/10', accent: 'bg-primary/5 text-primary', icon: 'text-primary' },
};

export default function MetricCard({ icon: Icon, label, value, sublabel, variant = 'default' }) {
  const v = variants[variant];

  return (
    <div className={cn(
      'paper-card px-4 py-3.5 relative overflow-hidden group',
      'hover:shadow-md transition-shadow duration-200',
      v.border
    )}>
      <div className="flex items-start justify-between mb-2.5">
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', v.accent)}>
          <Icon className="w-4.5 h-4.5" />
        </div>
      </div>
      <div>
        <p className="text-xl font-bold font-heading tracking-tight">{value}</p>
        <p className="text-[11px] text-muted-foreground font-medium mt-0.5">{label}</p>
        {sublabel && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sublabel}</p>}
      </div>
      <div className={cn(
        'absolute top-0 right-0 w-24 h-24 rounded-full opacity-[0.04] pointer-events-none -translate-y-1/2 translate-x-1/2',
        variant === 'default' ? 'bg-primary' : variant === 'success' ? 'bg-success' : variant === 'warning' ? 'bg-accent' : 'bg-primary'
      )} />
    </div>
  );
}
