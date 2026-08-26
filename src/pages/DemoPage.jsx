import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { toast } from 'sonner';

export default function DemoPage() {
  const navigate = useNavigate();
  const { checkUserAuth } = useAuth();

  useEffect(() => {
    const initDemo = async () => {
      try {
        const res = await fetch('/api/auth/demo', { method: 'POST' });
        if (!res.ok) throw new Error('Demo initialization failed');
        const data = await res.json();
        
        localStorage.setItem('app_access_token', data.access_token);
        localStorage.setItem('institution_profile', JSON.stringify({
          name: 'Nikunj × RazorPay',
          address: 'Demo Address, India',
          gst: '07AAACN0372J1ZD'
        }));
        
        await checkUserAuth();
        navigate('/');
        toast.success('Welcome to the Live Demo!');
      } catch (err) {
        console.error(err);
        toast.error('Failed to launch demo mode');
        navigate('/login');
      }
    };
    initDemo();
  }, [navigate, checkUserAuth]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-background">
      <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin mb-4"></div>
      <p className="text-sm font-medium text-foreground">Booting Demo Environment...</p>
      <p className="text-xs text-muted-foreground mt-1">Generating keys and seeding data</p>
    </div>
  );
}
