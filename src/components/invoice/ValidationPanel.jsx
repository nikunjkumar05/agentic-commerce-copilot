import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

const severityConfig = {
  info: { icon: Info, color: 'text-blue-500', bg: 'bg-blue-50' },
  warning: { icon: AlertTriangle, color: 'text-yellow-600', bg: 'bg-yellow-50' },
  error: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-50' },
};

export default function ValidationPanel({ score, suggestions, isValidating }) {
  if (isValidating) {
    return (
      <div className="p-6 text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary mb-3" />
        <p className="text-sm font-medium">Running AI compliance check...</p>
        <p className="text-xs text-muted-foreground mt-1">Checking GST, calculations, anomalies</p>
      </div>
    );
  }

  if (score === null || score === undefined) return null;

  const scoreColor = score >= 80 ? 'text-green-600' : score >= 50 ? 'text-yellow-600' : 'text-red-500';
  const scoreBg = score >= 80 ? 'stroke-green-500' : score >= 50 ? 'stroke-yellow-500' : 'stroke-red-500';

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 space-y-4">
      {/* Score Ring */}
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="35" fill="none" strokeWidth="6" className="stroke-muted" />
            <circle
              cx="40" cy="40" r="35" fill="none" strokeWidth="6"
              className={scoreBg}
              strokeDasharray={`${(score / 100) * 220} 220`}
              strokeLinecap="round"
            />
          </svg>
          <span className={cn("absolute inset-0 flex items-center justify-center text-xl font-bold", scoreColor)}>
            {score}
          </span>
        </div>
        <div>
          <p className="text-sm font-bold">Compliance Score</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {score >= 80 ? 'Invoice looks good!' : score >= 50 ? 'Some issues found' : 'Critical issues detected'}
          </p>
          <Badge className={cn("mt-1 text-[10px]", score >= 80 ? 'bg-green-100 text-green-700' : score >= 50 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700')}>
            {score >= 80 ? 'PASSED' : score >= 50 ? 'NEEDS REVIEW' : 'FAILED'}
          </Badge>
        </div>
      </div>

      {/* Issues */}
      {suggestions && suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase text-muted-foreground tracking-wider">Issues & Suggestions</p>
          {suggestions.map((s, i) => {
            const config = severityConfig[s.severity] || severityConfig.info;
            const Icon = config.icon;
            return (
              <div key={i} className={cn("flex items-start gap-2 p-3 rounded-xl", config.bg)}>
                <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", config.color)} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold">{s.field}: {s.issue}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{s.suggestion}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(!suggestions || suggestions.length === 0) && score >= 80 && (
        <div className="flex items-center gap-2 p-3 bg-green-50 rounded-xl">
          <CheckCircle2 className="w-4 h-4 text-green-600" />
          <p className="text-xs font-medium text-green-700">All compliance checks passed</p>
        </div>
      )}
    </motion.div>
  );
}