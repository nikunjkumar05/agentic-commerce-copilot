import { cn } from '@/lib/utils';

export default function Stamp({ text = 'APPROVED', variant = 'gold', className, animate = false }) {
  const colors = {
    gold: { text: '#D4A843', border: '#D4A843', bg: 'rgba(212, 168, 67, 0.06)' },
    red: { text: '#C4282B', border: '#C4282B', bg: 'rgba(196, 40, 43, 0.06)' },
    green: { text: '#3D8C54', border: '#3D8C54', bg: 'rgba(61, 140, 84, 0.06)' },
    navy: { text: '#1C3A5E', border: '#1C3A5E', bg: 'rgba(28, 58, 94, 0.06)' },
  };
  const c = colors[variant] || colors.gold;

  return (
    <svg
      viewBox="0 0 120 120"
      className={cn('w-24 h-24', animate && 'animate-stamp-in', className)}
      aria-hidden="true"
    >
      <defs>
        <filter id="seal-rough">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.8" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <circle cx="60" cy="60" r="57" fill="none" stroke={c.border} strokeWidth="1.5" opacity="0.3" />
      <circle cx="60" cy="60" r="54" fill={c.bg} stroke={c.border} strokeWidth="1" />
      <circle cx="60" cy="60" r="48" fill="none" stroke={c.border} strokeWidth="0.5" opacity="0.4" />
      <circle cx="60" cy="60" r="46" fill="none" stroke={c.border} strokeWidth="0.5" opacity="0.2" />
      <text x="60" y="52" textAnchor="middle" className="text-[8px]" fill={c.text} fontFamily="Inter" fontWeight="600" letterSpacing="3">
        SEETA
      </text>
      <text x="60" y="64" textAnchor="middle" className="text-[6px]" fill={c.text} fontFamily="Inter" fontWeight="400" letterSpacing="2" opacity="0.7">
        NSUT × AIC
      </text>
      <line x1="28" y1="72" x2="92" y2="72" stroke={c.border} strokeWidth="0.5" opacity="0.5" />
      <text x="60" y="84" textAnchor="middle" className="text-[7px]" fill={c.text} fontFamily="Inter" fontWeight="700" letterSpacing="2.5">
        {text}
      </text>
    </svg>
  );
}

export function SmallStamp({ status = 'draft', className }) {
  const config = {
    draft: { text: 'DRAFT', variant: 'navy' },
    validated: { text: 'VALIDATED', variant: 'gold' },
    stored: { text: 'STORED', variant: 'green' },
    paid: { text: 'PAID', variant: 'green' },
    anomaly: { text: 'ANOMALY', variant: 'red' },
  };
  const c = config[status] || config.draft;

  return (
    <svg
      viewBox="0 0 80 80"
      className={cn('w-12 h-12 opacity-60', className)}
      aria-hidden="true"
    >
      <circle cx="40" cy="40" r="38" fill="none" stroke={c.variant === 'gold' ? '#D4A843' : c.variant === 'green' ? '#3D8C54' : c.variant === 'red' ? '#C4282B' : '#1C3A5E'} strokeWidth="1.2" opacity="0.5" />
      <circle cx="40" cy="40" r="35" fill="none" stroke={c.variant === 'gold' ? '#D4A843' : c.variant === 'green' ? '#3D8C54' : c.variant === 'red' ? '#C4282B' : '#1C3A5E'} strokeWidth="0.8" opacity="0.3" />
      <text x="40" y="44" textAnchor="middle" className="text-[5.5px]" fill={c.variant === 'gold' ? '#D4A843' : c.variant === 'green' ? '#3D8C54' : c.variant === 'red' ? '#C4282B' : '#1C3A5E'} fontFamily="Inter" fontWeight="600" letterSpacing="2">
        {c.text}
      </text>
    </svg>
  );
}
