import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bot, User, MessageSquare, Clock, ArrowRight, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Transcripts() {
  const [selectedSessionId, setSelectedSessionId] = useState(null);

  const { data: sessions = [], isLoading: isLoadingList } = useQuery({
    queryKey: ['chat_sessions'],
    queryFn: async () => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch('/api/chat/sessions', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load sessions');
      return res.json();
    }
  });

  const { data: activeSession, isLoading: isLoadingSession } = useQuery({
    queryKey: ['chat_session', selectedSessionId],
    queryFn: async () => {
      if (!selectedSessionId) return null;
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/chat/sessions/${selectedSessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load session');
      return res.json();
    },
    enabled: !!selectedSessionId
  });

  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const token = localStorage.getItem('app_access_token');
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete transcript');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat_sessions'] });
      setSelectedSessionId(null);
    }
  });

  return (
    <div className="w-full h-[calc(100vh-100px)] p-4 md:p-8">
      <div className="w-full h-full mx-auto flex border rounded-2xl overflow-hidden bg-background shadow-xl">
      
      {/* Sidebar List */}
      <div className="w-1/3 min-w-[300px] border-r flex flex-col bg-muted/20">
        <div className="p-4 border-b bg-card">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-indigo-600" /> Transcripts
          </h2>
          <p className="text-xs text-muted-foreground mt-1">Audit AI negotiations in real-time</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoadingList && <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>}
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => setSelectedSessionId(session.id)}
              className={`w-full text-left p-3 rounded-lg flex flex-col gap-1 transition-colors ${
                selectedSessionId === session.id 
                  ? 'bg-indigo-50 border-indigo-200 shadow-sm border' 
                  : 'hover:bg-accent border border-transparent'
              }`}
            >
              <div className="flex justify-between items-center w-full">
                <span className="font-semibold text-sm truncate">{session.buyer_name || 'Anonymous Buyer'}</span>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {formatDistanceToNow(new Date(session.updated_at), { addSuffix: true })}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs text-muted-foreground">
                <span className="font-mono text-[10px]">ID: {session.id.slice(0, 8)}</span>
                <span className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{session.message_count} msgs</span>
              </div>
            </button>
          ))}
          {!isLoadingList && sessions.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">No chat sessions found.</div>
          )}
        </div>
      </div>

      {/* Transcript Viewer */}
      <div className="flex-1 flex flex-col bg-card relative">
        {selectedSessionId && activeSession ? (
          <>
            <div className="p-4 border-b flex justify-between items-center bg-background z-10 shadow-sm">
              <div>
                <h3 className="font-bold text-base">{activeSession.buyer_name || 'Anonymous Buyer'}</h3>
                <p className="text-xs text-muted-foreground font-mono">Session ID: {activeSession.id}</p>
              </div>
              <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700" 
                onClick={() => deleteMutation.mutate(activeSession.id)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="w-4 h-4 mr-1.5" />
                Delete
              </Button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">
              {activeSession.messages?.map((msg, i) => {
                if (msg.role === 'system') return null; // hide system prompt
                const isAgent = msg.role === 'assistant' || msg.role === 'tool';
                
                return (
                  <div key={i} className={`flex gap-3 ${isAgent ? '' : 'flex-row-reverse'}`}>
                    <div className={`max-w-[80%] rounded-2xl p-4 shadow-sm ${
                      isAgent 
                        ? 'bg-white border border-slate-200 rounded-tl-sm' 
                        : 'bg-indigo-600 text-white rounded-tr-sm'
                    }`}>
                      {msg.content ? (
                        <p className={`text-sm whitespace-pre-wrap ${isAgent ? 'text-slate-800' : 'text-white'}`}>{msg.content}</p>
                      ) : (
                        <p className="text-sm italic text-muted-foreground">Processing tool call...</p>
                      )}
                      
                      {msg.tool_calls && (
                        <div className="mt-2 space-y-1">
                          {msg.tool_calls.map((tc, j) => (
                            <div key={j} className="bg-slate-100 p-2 rounded text-[10px] font-mono text-slate-600 border border-slate-200">
                              <span className="font-bold text-indigo-600">{tc.function.name}</span>({tc.function.arguments})
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <MessageSquare className="w-12 h-12 mb-4 opacity-20" />
            <p>Select a session to view the transcript</p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
