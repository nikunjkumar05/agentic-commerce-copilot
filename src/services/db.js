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
    },
    loginViaEmailPassword: async (email, password) => {
      const data = await fetchApi('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      if (data.access_token) localStorage.setItem('app_access_token', data.access_token);
      return data;
    },
    loginWithProvider: (provider, redirectUrl) => {
      console.warn("OAuth providers not supported in hackathon backend");
    },
    register: async ({ email, password }) => {
      return fetchApi('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
    },
    verifyOtp: async ({ email, otpCode }) => {
      // For hackathon: Auto-login on fake OTP verify
      const data = await fetchApi('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: '123' }) // We don't have the password here, so we will actually just mock it or rely on the fact that we can tweak the backend
      });
      return data;
    },
    resendOtp: async (email) => {
      console.log('Mock OTP sent to', email);
      return true;
    },
    setToken: (token) => {
      localStorage.setItem('app_access_token', token);
    }
  },
  integrations: {
    Core: {
      InvokeLLM: async (data) => fetchApi('/llm/invoke', { method: 'POST', body: JSON.stringify(data) })
    }
  }
};
