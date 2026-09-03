import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, User, ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

export default function Landing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  
  useEffect(() => {
    if (user) {
      navigate(user.role === 'buyer' ? '/buyer' : '/merchant');
    }
  }, [user, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center -mt-24 px-4 relative z-10">
      <div className="max-w-4xl w-full text-center space-y-12">
        <div className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-heading font-bold text-gray-900 tracking-tight">
            AgentPay Gateway
          </h1>
          <p className="text-xl text-gray-500 max-w-2xl mx-auto">
            Welcome to the interactive hackathon demo. Please select your persona to begin testing the autonomous checkout flow.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          {/* Buyer Portal */}
          <button 
            onClick={() => navigate('/login?role=buyer')}
            className="group relative bg-white border-2 border-indigo-100 rounded-2xl p-8 hover:border-indigo-500 hover:shadow-2xl transition-all duration-300 text-left flex flex-col items-start gap-4 overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110" />
            <div className="w-16 h-16 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center relative z-10">
              <User className="w-8 h-8" />
            </div>
            <div className="relative z-10">
              <h2 className="text-2xl font-bold text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">I am the Buyer</h2>
              <p className="text-sm text-gray-500 mb-6">
                Enter the consumer-facing chat UI. Talk to the Agent, ask for product recommendations, and let the AI autonomously process your checkout via Razorpay.
              </p>
            </div>
            <div className="mt-auto flex items-center text-indigo-600 font-semibold relative z-10">
              Login as Buyer <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-2 transition-transform" />
            </div>
          </button>

          {/* Merchant Portal */}
          <button 
            onClick={() => navigate('/login?role=merchant')}
            className="group relative bg-white border-2 border-slate-100 rounded-2xl p-8 hover:border-slate-800 hover:shadow-2xl transition-all duration-300 text-left flex flex-col items-start gap-4 overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-slate-50 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110" />
            <div className="w-16 h-16 rounded-xl bg-slate-100 text-slate-800 flex items-center justify-center relative z-10">
              <Store className="w-8 h-8" />
            </div>
            <div className="relative z-10">
              <h2 className="text-2xl font-bold text-gray-900 mb-2 group-hover:text-slate-800 transition-colors">I am the Merchant</h2>
              <p className="text-sm text-gray-500 mb-6">
                Enter the business owner dashboard. Track generated revenue, view the AI audit trails, and mass-launch AI Upsell Campaigns to your customer base.
              </p>
            </div>
            <div className="mt-auto flex items-center text-slate-800 font-semibold relative z-10">
              Login as Merchant <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-2 transition-transform" />
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
