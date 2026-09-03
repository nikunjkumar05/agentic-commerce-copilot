import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Bot, Terminal, Server, Zap, CheckCircle2, Loader2, ArrowRightLeft, ShieldCheck, Play } from 'lucide-react';

export default function SimulationTheater() {
  const [step, setStep] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const startSimulation = () => {
    setIsRunning(true);
    setStep(1);
  };

  const resetSimulation = () => {
    setIsRunning(false);
    setStep(0);
  };

  useEffect(() => {
    if (step === 0 || step >= 7) {
      if (step >= 7) setIsRunning(false);
      return;
    }
    
    const timers = [
      { step: 1, delay: 2000 }, // Buyer fetches catalog
      { step: 2, delay: 2000 }, // Buyer sends intent
      { step: 3, delay: 2500 }, // Seller evaluates
      { step: 4, delay: 2500 }, // Seller creates invoice & Order
      { step: 5, delay: 2000 }, // Buyer approves
      { step: 6, delay: 2500 }, // Seller captures
    ];

    const currentDelay = timers.find(t => t.step === step)?.delay || 2000;
    const timer = setTimeout(() => {
      setStep(prev => prev + 1);
    }, currentDelay);

    return () => clearTimeout(timer);
  }, [step]);

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b bg-card z-10 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
            <ArrowRightLeft className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <h2 className="text-lg font-bold font-heading leading-tight">B2B Agent Simulation</h2>
            <p className="text-xs text-muted-foreground">Scripted demo — no real API calls are made</p>
          </div>
        </div>
        {!isRunning && step === 0 ? (
          <Button onClick={startSimulation} className="bg-blue-600 hover:bg-blue-700 text-white gap-2">
            <Play className="w-4 h-4" /> Start Demo
          </Button>
        ) : (
          <Button onClick={resetSimulation} variant="outline" size="sm">
            Reset
          </Button>
        )}
      </div>

      {/* Split Screen Theater */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden p-4 gap-4">
        
        {/* Left Side: External Buyer AI */}
        <div className="flex-1 rounded-2xl bg-[#0F172A] border border-slate-800 flex flex-col overflow-hidden relative shadow-2xl">
          <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-mono text-slate-300 font-bold">EXTERNAL_PROCUREMENT_AGENT</span>
          </div>
          <div className="flex-1 p-4 font-mono text-xs text-green-400 space-y-3 overflow-y-auto">
            <div className="opacity-50">&gt; Initializing procurement routines... OK</div>
            <div className="opacity-50">&gt; Awaiting trading trigger...</div>
            
            {step >= 1 && (
              <div className="animate-in fade-in slide-in-from-left-2">
                <span className="text-blue-400">&gt; [API GET]</span> Requesting /catalog.json from AgentPay Gateway...<br/>
                <span className="text-slate-400 pl-4">HTTP 200 OK - Found 3 items.</span>
              </div>
            )}
            
            {step >= 2 && (
              <div className="animate-in fade-in slide-in-from-left-2">
                <span className="text-blue-400">&gt; [DECISION]</span> Target acquired: "Enterprise IT License". Price: ₹5000.<br/>
                <span className="text-blue-400">&gt; [API POST]</span> Sending Purchase Intent to /api/agent/chat...
              </div>
            )}

            {step === 2 && <Loader2 className="w-4 h-4 animate-spin text-green-400 mt-2" />}

            {step >= 5 && (
              <div className="animate-in fade-in slide-in-from-left-2 text-yellow-400">
                <span className="text-blue-400">&gt; [API GET]</span> Requesting /catalog.json from AgentPay Gateway...<br/>
                <span className="text-muted-foreground">&gt; [CATALOG] 6 machine-readable products discovered</span><br/>
                <span className="text-yellow-400">&gt; [HTTP 402]</span> Merchant Agent challenged: Payment Required (order_... / inv_...)<br/>
                <span className="text-primary">&gt; [DELEGATION CHECK]</span> Requested amount under budget. Auto-approving...<br/>
                <span className="text-green-400">&gt; [RAZORPAY S2S]</span> Mandate charged. Verified: status=captured.<br/>
                <span className="text-green-500 font-bold">&gt; [SETTLED]</span> Machine transaction complete. Double-entry SHA-256 logged.
              </div>
            )}

            {step >= 7 && (
              <div className="animate-in fade-in slide-in-from-left-2 mt-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-300">
                &gt; [DEMO COMPLETE] Script finished — no real payment was processed.
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Agentic Commerce Merchant AI */}
        <div className="flex-1 rounded-2xl bg-card border flex flex-col overflow-hidden relative shadow-2xl">
          <div className="bg-muted/50 px-4 py-2 border-b flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" />
            <span className="text-xs font-heading font-bold text-foreground">AGENTIC_COMMERCE_CO_PILOT (SELLER)</span>
          </div>
          <div className="flex-1 p-4 text-sm space-y-4 overflow-y-auto">
            <div className="text-muted-foreground text-xs flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Listening on network port...
            </div>

            {step >= 3 && (
              <div className="animate-in fade-in slide-in-from-right-2 bg-muted/40 p-3 rounded-lg border">
                <div className="flex items-center gap-2 font-bold mb-1">
                  <Server className="w-4 h-4 text-blue-500" /> Incoming Purchase Intent
                </div>
                <div className="text-xs space-y-1 text-muted-foreground">
                  <p>Request: "Enterprise IT License" (₹5000)</p>
                  <p className="flex items-center gap-1 text-green-600 dark:text-green-400">
                    <ShieldCheck className="w-3 h-3" /> Compliance Score Bounds Check: PASSED
                  </p>
                </div>
              </div>
            )}

            {step >= 4 && (
              <div className="animate-in fade-in slide-in-from-right-2 bg-primary/5 p-3 rounded-lg border border-primary/20">
                <div className="flex items-center gap-2 font-bold mb-1">
                  <Zap className="w-4 h-4 text-yellow-500" /> Agent Autonomous Action
                </div>
                <div className="text-xs space-y-1 text-muted-foreground">
                  <p>1. Drafting Invoice INV-99382...</p>
                  <p>2. Communicating with Razorpay API...</p>
                  <p>3. Order <span className="font-mono text-primary">order_P9K3j8L2</span> created.</p>
                </div>
              </div>
            )}

            {step >= 6 && (
              <div className="animate-in fade-in slide-in-from-right-2 bg-blue-500/10 p-3 rounded-lg border border-blue-500/30">
                <div className="flex items-center gap-2 font-bold text-blue-700 dark:text-blue-300 mb-1">
                  <CheckCircle2 className="w-4 h-4" /> Signature Verified
                </div>
                <div className="text-xs space-y-1 text-blue-600/80 dark:text-blue-300/80">
                  <p>Verifying Razorpay Webhook Signature...</p>
                  <p>Updating Invoice INV-99382 status to PAID.</p>
                </div>
              </div>
            )}

            {step >= 7 && (
              <div className="animate-in zoom-in duration-500 mt-4 p-4 bg-green-500/10 border border-green-500/30 rounded-xl flex items-center justify-between">
                <div>
                  <p className="font-bold text-green-700 dark:text-green-400">Trade Complete</p>
                  <p className="text-xs text-green-600/80 dark:text-green-400/80">₹5,000 simulated via Razorpay Route — demo only</p>
                </div>
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              </div>
            )}
            
            {(step === 3 || step === 4 || step === 6) && (
               <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mt-2" />
            )}
          </div>
        </div>
        
      </div>
    </div>
  );
}
