import React, { createContext, useState, useContext, useEffect } from 'react';
import { db } from '@/services/db';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);

  // Check authentication on initial load
  useEffect(() => {
    checkUserAuth();
  }, []);

  const checkUserAuth = async () => {
    setIsLoadingAuth(true);
    const token = localStorage.getItem('app_access_token');
    
    if (!token) {
      setUser(null);
      setIsAuthenticated(false);
      setIsLoadingAuth(false);
      return;
    }

    try {
      // Hit the backend /api/auth/me endpoint using our custom db.js wrapper
      const currentUser = await db.auth.me();
      if (currentUser) {
        setUser(currentUser);
        setIsAuthenticated(true);
      } else {
        throw new Error("Invalid session");
      }
    } catch (error) {
      console.error('User auth check failed:', error);
      // If the token is invalid or expired, clear it out
      localStorage.removeItem('app_access_token');
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const logout = () => {
    // Clear the token and state securely
    localStorage.removeItem('app_access_token');
    setUser(null);
    setIsAuthenticated(false);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      logout,
      checkUserAuth,
      // Returning legacy mock states so your ProtectedRoute components don't break
      isLoadingPublicSettings: false,
      authError: null,
      appPublicSettings: {},
      authChecked: !isLoadingAuth
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
