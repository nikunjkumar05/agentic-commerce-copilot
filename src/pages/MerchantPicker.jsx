import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Store, ArrowRight } from 'lucide-react';

const STORE_KEY = 'agent_selected_merchant';

export default function MerchantPicker() {
  const navigate = useNavigate();
  const { data: merchants = [], isLoading } = useQuery({
    queryKey: ['merchants'],
    queryFn: async () => {
      const res = await fetch('/api/merchants');
      if (!res.ok) throw new Error('Failed to load merchants');
      return res.json();
    }
  });

  const pick = (m) => {
    localStorage.setItem(STORE_KEY, m.id);
    localStorage.setItem(STORE_KEY + '_name', m.name);
    navigate('/buyer');
  };

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4 pb-24 w-full">
      <div>
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Store className="w-5 h-5 text-indigo-500" /> Choose a Store
        </h2>
        <p className="text-sm text-muted-foreground">Pick a merchant to shop with. Your agent will only see that store's catalog.</p>
      </div>

      {isLoading ? (
        <div className="text-center p-8 text-muted-foreground text-sm">Loading stores…</div>
      ) : merchants.length === 0 ? (
        <div className="text-center p-8 border border-dashed rounded-xl text-muted-foreground text-sm">
          No merchant stores are open yet.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {merchants.map(m => (
            <Card key={m.id} className="cursor-pointer hover:border-indigo-300 hover:shadow-md transition-all" onClick={() => pick(m)}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
                    <Store className="w-4 h-4 text-indigo-500" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-tight">{m.name}</p>
                    <p className="text-xs text-muted-foreground">{m.product_count} product{m.product_count === 1 ? '' : 's'}</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
