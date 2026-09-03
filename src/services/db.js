const API_BASE = '/api';

async function fetchApi(endpoint, options = {}) {
  const token = localStorage.getItem('app_access_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` })
  };
  
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  
  if (res.status === 401) {
    localStorage.removeItem('app_access_token');
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }
  
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const error = new Error(errBody.message || 'API request failed');
    error.status = res.status;
    throw error;
  }
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
      list: async (sort, limit) => fetchApi(`/invoices?sort=${encodeURIComponent(sort)}&limit=${limit}`),
      read: async (id) => fetchApi(`/invoices/${id}`),
      create: async (data) => fetchApi('/invoices', { method: 'POST', body: JSON.stringify(data) }),
      update: async (id, data) => fetchApi(`/invoices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      delete: async (id) => fetchApi(`/invoices/${id}`, { method: 'DELETE' })
    },
    AgentAuditLog: {
      filter: async () => fetchApi('/audit-logs'),
      list: async (sort, limit) => fetchApi(`/audit-logs?sort=${encodeURIComponent(sort)}&limit=${limit}`),
      create: async (data) => fetchApi('/audit-logs', { method: 'POST', body: JSON.stringify(data) })
    }
  },
  auth: {
    isAuthenticated: async () => !!localStorage.getItem('app_access_token'),
    me: async () => {
      return fetchApi('/auth/me');
    },
    loginViaEmailPassword: async (email, password, role) => {
      const data = await fetchApi('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, role })
      });
      if (data.access_token) localStorage.setItem('app_access_token', data.access_token);
      return data;
    },
    loginWithProvider: (provider, redirectUrl) => {
      console.warn("OAuth providers not supported in hackathon backend");
    },
    register: async ({ email, password, role }) => {
      return fetchApi('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, role })
      });
    },
    verifyOtp: async ({ email, otp }) => {
      const data = await fetchApi('/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email, otp })
      });
      if (data.access_token) localStorage.setItem('app_access_token', data.access_token);
      return data;
    },
    resendOtp: async (email) => {
      return fetchApi('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email }) });
    },
    logout: async (redirectPath) => {
      try { await fetchApi('/auth/logout', { method: 'POST' }); } catch {}
      localStorage.removeItem('app_access_token');
      if (typeof window !== 'undefined') {
        window.location.href = redirectPath || '/login';
      }
    },
    setToken: (token) => {
      localStorage.setItem('app_access_token', token);
    }
  },
  integrations: {
    Core: {
      InvokeLLM: async (data) => fetchApi('/llm/invoke', { method: 'POST', body: JSON.stringify(data) })
    },
    Agent: {
      autoSettle: async (data) => fetchApi('/agent/auto-settle', { method: 'POST', body: JSON.stringify(data) })
    }
  }
};
