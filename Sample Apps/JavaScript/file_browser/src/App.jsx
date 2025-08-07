/**
 * App.jsx - Main Application Component
 * This file defines the main application structure, routing configuration,
 * and protected route implementation for the Dropbox file browser application.
 */

import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginPage from './components/LoginPage';
import FileBrowser from './components/FileBrowser';
import './App.css';

/**
 * ProtectedRoute Component
 * A wrapper component that protects routes requiring authentication.
 * Redirects to the login page if the user is not authenticated.
 * 
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.children - Child components to render when authenticated
 */
function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();

  // Show loading state while authentication status is being determined
  if (loading) {
    return <div>Loading...</div>;
  }

  // Redirect to login page if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/" />;
  }

  return children;
}

/**
 * AppRoutes Component
 * Defines the application's routing configuration.
 * Maps URLs to their corresponding components and handles protected routes.
 */
function AppRoutes() {
  return (
    <Routes>
      {/* Login page and OAuth callback handler - public route */}
      <Route path="/" element={<LoginPage />} />
      <Route path="/oauth-callback" element={<LoginPage />} />
      
      {/* Protected file browser route - requires authentication */}
      <Route
        path="/browser/*"
        element={
          <ProtectedRoute>
            <FileBrowser />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

/**
 * App Component
 * The root component of the application.
 * Sets up routing and authentication context providers.
 */
function App() {
  return (
    <Router>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </Router>
  );
}

export default App;
