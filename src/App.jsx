import { Toaster } from 'sonner';
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ProtectedRoute from '@/components/ProtectedRoute';

import Campaigns from '@/pages/Campaigns';
import Landing from '@/pages/Landing';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

import AppLayout from '@/components/layout/AppLayout';
import Dashboard from '@/pages/Dashboard';
import NewInvoice from '@/pages/NewInvoice';
import InvoiceDetail from '@/pages/InvoiceDetail';
import StoragePage from '@/pages/StoragePage';
import SettingsPage from '@/pages/SettingsPage';
import AgentChat from '@/pages/AgentChat';
import BuyerOrders from '@/pages/BuyerOrders';
import BuyerSettings from '@/pages/BuyerSettings';
import AuditTrailPage from '@/pages/AuditTrailPage';
import DemoPage from '@/pages/DemoPage';

import CatalogManager from '@/pages/CatalogManager';
import Transcripts from '@/pages/Transcripts';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin mx-auto mb-3"></div>
          <p className="text-xs text-muted-foreground font-medium">Loading GovtInvoice Co-Pilot...</p>
        </div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/demo" element={<DemoPage />} />
      
      <Route path="/" element={<Landing />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<AppLayout />}>
          <Route path="/merchant" element={<Dashboard />} />
          <Route path="/buyer" element={<AgentChat />} />
          <Route path="/buyer/orders" element={<BuyerOrders />} />
          <Route path="/buyer/settings" element={<BuyerSettings />} />
          <Route path="/merchant/campaigns" element={<Campaigns />} />
          <Route path="/merchant/catalog" element={<CatalogManager />} />
          <Route path="/merchant/transcripts" element={<Transcripts />} />
          <Route path="/merchant/audit" element={<AuditTrailPage />} />
          <Route path="/merchant/invoice/new" element={<NewInvoice />} />
          <Route path="/invoice/:id" element={<InvoiceDetail />} />
          <Route path="/merchant/storage" element={<StoragePage />} />
          <Route path="/merchant/settings" element={<SettingsPage />} />
          <Route path="/audit" element={<Navigate to="/merchant/audit" replace />} />
        </Route>
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
          <Toaster />
        </Router>
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
