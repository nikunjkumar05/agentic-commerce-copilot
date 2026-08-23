const API_BASE = '/api';

async function fetchApi(endpoint, options = {}) {
  const token = localStorage.getItem('app_access_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` })
  };
  
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) throw new Error('API request failed');
  return res.json();
}

export const db = {
  entities: {
    Invoice: {
      filter: async (params) => {
        if (params?.id) {
          const item = await fetchApi(`/invoices/${params.id}`);
          return item ? [item] : [];
        }
        return fetchApi('/invoices');
      },
      create: async (data) => fetchApi('/invoices', { method: 'POST', body: JSON.stringify(data) }),
      update: async (id, data) => fetchApi(`/invoices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      delete: async (id) => fetchApi(`/invoices/${id}`, { method: 'DELETE' })
    },
    AgentAuditLog: {
      filter: async () => fetchApi('/audit-logs'),
      create: async (data) => fetchApi('/audit-logs', { method: 'POST', body: JSON.stringify(data) })
    }
  },
  auth: {
    isAuthenticated: async () => !!localStorage.getItem('app_access_token'),
    me: async () => {
      try { return await fetchApi('/auth/me'); } catch { return null; }
    }
  }
};
