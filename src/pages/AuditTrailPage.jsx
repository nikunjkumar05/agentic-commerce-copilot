import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/services/db';
import { format } from 'date-fns';
import { Shield, Zap, CheckCircle2, FileText, AlertTriangle, Link as LinkIcon, Loader2, Lock, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function AuditTrailPage() {
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationComplete, setVerificationComplete] = useState(false);
  const [verificationError, setVerificationError] = useState(null);
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['audit-logs-full'],
    queryFn: () => db.entities.AgentAuditLog.list('-created_date', 100),
  });

  const verifyIntegrity = async () => {
    setIsVerifying(true);
    setVerificationComplete(false);
    setVerificationError(null);
    
    try {
      // Call the real backend cryptographic verification endpoint
      const res = await fetch('/api/audit-logs/verify', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('app_access_token')}`
        }
      });
      const data = await res.json();
      
      // Artificial delay just for the UI dramatic effect during demo
      await new Promise(r => setTimeout(r, 1200));

      if (data.valid) {
        setVerificationComplete(true);
      } else {
        setVerificationError(`Tampering Detected! Block ID: ${data.broken_log_id}`);
      }
    } catch (err) {
      setVerificationError("Failed to reach verification server.");
    } finally {
      setIsVerifying(false);
    }
  };

  const getActionConfig = (action) => {
    const lowerAction = action?.toLowerCase() || '';
    if (lowerAction.includes('settle')) return { icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-500/10' };
    if (lowerAction.includes('valid')) return { icon: Shield, color: 'text-blue-500', bg: 'bg-blue-500/10' };
    if (lowerAction.includes('delegat')) return { icon: LinkIcon, color: 'text-green-500', bg: 'bg-green-500/10' };
    if (lowerAction.includes('block') || lowerAction.includes('fail')) return { icon: AlertTriangle, color: 'text-red-500', bg: 'bg-red-500/10' };
    return { icon: FileText, color: 'text-purple-500', bg: 'bg-purple-500/10' };
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b bg-card z-10 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold font-heading leading-tight">Cryptographic Audit Trail</h2>
          <p className="text-xs text-muted-foreground">Immutable ledger of autonomous agent actions</p>
        </div>
        <Button 
          onClick={verifyIntegrity} 
          disabled={isVerifying || isLoading || logs.length === 0}
          className={`${verificationComplete ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-slate-800 hover:bg-slate-900 text-white'} gap-2`}
        >
          {isVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
          {isVerifying ? 'Verifying Chain...' : verificationComplete ? 'Chain Validated' : 'Verify Integrity'}
        </Button>
      </div>

      {/* Timeline List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          
          {verificationComplete && (
            <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-start gap-3 animate-in fade-in zoom-in duration-500">
              <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-bold text-green-700 dark:text-green-400">Cryptographic Integrity Verified</h4>
                <p className="text-xs text-green-600/80 dark:text-green-400/80 mt-1">
                  All {logs.length} agent actions have been mathematically verified against their SHA-256 hash chains. Zero tampering detected.
                </p>
              </div>
            </div>
          )}

          {verificationError && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-3 animate-in fade-in zoom-in duration-500">
              <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-bold text-red-700 dark:text-red-400">CRITICAL: Ledger Integrity Compromised</h4>
                <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-1">
                  {verificationError}. The mathematical hash chain has been broken, indicating the database was tampered with.
                </p>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : logs.length === 0 ? (
            <div className="text-center p-8 text-sm text-muted-foreground">No agent actions recorded yet.</div>
          ) : (
            <div className="relative border-l-2 border-muted ml-4 md:ml-0 space-y-8">
              {logs.map((log, index) => {
                const config = getActionConfig(log.action);
                const Icon = config.icon;
                const prevHash = log.prev_hash || '0'.repeat(64);
                const currentHash = log.hash || 'Hash pending...';

                return (
                  <div key={log.id} className="relative pl-8 md:pl-10">
                    {/* Timeline Node */}
                    <div className={`absolute -left-[11px] top-1 w-5 h-5 rounded-full border-2 border-background ${config.bg} flex items-center justify-center`}>
                      <Icon className={`w-3 h-3 ${config.color}`} />
                    </div>

                    {/* Content Card */}
                    <Card className="shadow-sm border-muted">
                      <CardContent className="p-4 space-y-3">
                        <div className="flex justify-between items-start">
                          <Badge variant="outline" className={`${config.color} border-current bg-transparent`}>
                            {log.action.replace(/_/g, ' ').toUpperCase()}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {log.created_date ? format(new Date(log.created_date), 'dd MMM yyyy, HH:mm:ss') : 'Unknown Time'}
                          </span>
                        </div>

                        <p className="text-sm text-foreground">{log.details}</p>

                        {/* Cryptographic Hash Data */}
                        <div className="bg-slate-900 rounded-md p-3 text-[10px] font-mono text-slate-400 space-y-1.5 overflow-hidden">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500">PREV_HASH:</span>
                            <span className="truncate">{prevHash}</span>
                          </div>
                          {log.tx_hash && (
                            <div className="flex items-center gap-2">
                              <span className="text-blue-400">TX_HASH:</span>
                              <span className="truncate text-blue-300">{log.tx_hash}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <span className="text-green-400">CURR_HASH:</span>
                            <span className="truncate text-green-300">{currentHash}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Chain link visual connector between cards */}
                    {index !== logs.length - 1 && (
                      <div className="absolute left-10 -bottom-6 text-muted-foreground/30">
                        <ArrowDown className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
