/**
 * LoginPage.jsx - Authentication Entry Point and Callback Handler
 * This component provides the initial login interface for both individual and team-based
 * Dropbox authentication, and handles the OAuth callback flow.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getAuthUrl, getTokensFromCode } from '../utils/dropboxClient';
import { DROPBOX_CONFIG, useAuth } from '../contexts/AuthContext';
import './LoginPage.css';

/**
 * LoginPage Component
 * Provides UI for initiating Dropbox authentication flow and handles OAuth callback.
 * Supports both individual user and team authentication.
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const { handleLogin } = useAuth();
  const [searchParams] = useSearchParams();
  
  // State management
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [offlineAccess, setOfflineAccess] = useState(false);
  
  // Prevents multiple token exchange attempts
  const hasExchangedCode = useRef(false);

  /**
   * Initiates authentication flow by redirecting to Dropbox OAuth page
   * @param {boolean} teamAuth - Whether to request team-level permissions
   */
  const handleLoginRedirect = async (teamAuth) => {
    try {
      setIsLoading(true);
      // Store offline access preference in session storage before redirect
      sessionStorage.setItem('requestedOfflineAccess', offlineAccess.toString());
      
      const authUrl = await getAuthUrl(
        DROPBOX_CONFIG.clientId,
        DROPBOX_CONFIG.redirectUri,
        offlineAccess,
        teamAuth
      );
      window.location.href = authUrl;
    } catch (error) {
      console.error(`Failed to get ${teamAuth ? 'team' : 'user'} auth URL:`, error);
      setError('Failed to start login process. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Processes the OAuth callback parameters and exchanges the code for tokens
   * Handles various error cases and successful authentication
   */
  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get('code');
      // If no code is present, this is not a callback - show login page
      if (!code) {
        return;
      }

      // Prevent multiple token exchanges
      if (hasExchangedCode.current) {
        return;
      }

      setIsLoading(true);

      const error = searchParams.get('error');
      const errorDescription = searchParams.get('error_description');
      
      // Get offline access preference from session storage
      const offlineAccess = sessionStorage.getItem('requestedOfflineAccess') === 'true';
      // Clean up session storage
      sessionStorage.removeItem('requestedOfflineAccess');

      // Handle OAuth errors
      if (error || errorDescription) {
        const errorMessage = errorDescription || error;
        console.error('OAuth error:', { error, errorDescription });
        setError(`Authentication failed: ${errorMessage}`);
        setIsLoading(false);
        return;
      }

      try {
        // Mark code exchange as in progress
        hasExchangedCode.current = true;    
        // Exchange code for tokens
        const tokens = await getTokensFromCode(
          DROPBOX_CONFIG.clientId,
          code,
          DROPBOX_CONFIG.redirectUri
        );
        
        // Complete authentication and redirect to file browser
        handleLogin(tokens, offlineAccess);
        navigate('/browser');
      } catch (error) {
        console.error('Token exchange error:', error);
        setError(`Failed to complete authentication: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    handleCallback();
  }, [searchParams, handleLogin, navigate]);

  // If there's an error, show error state
  if (error) {
    return (
      <div className="login-container">
        <h2>Authentication Error</h2>
        <p className="error-message">{error}</p>
        <button className="btn" onClick={() => setError(null)}>
          Try Again
        </button>
      </div>
    );
  }

  // If we're processing a callback, show loading state
  if (isLoading && searchParams.get('code')) {
    return (
      <div className="login-container">
        <h2>Completing authentication...</h2>
        <p>Please wait while we complete the authentication process.</p>
      </div>
    );
  }

  // Show login interface
  return (
    <div className="login-container">
      <h1>Dropbox File Browser</h1>
      
      {/* Offline access toggle */}
      <div className="auth-options">
        <label className="offline-access-option">
          <input
            type="checkbox"
            checked={offlineAccess}
            onChange={(e) => setOfflineAccess(e.target.checked)}
          />
          Enable offline access (generates refresh token)
        </label>
      </div>

      {/* Authentication buttons */}
      <div className="login-buttons">
        <button 
          className="btn"
          onClick={() => handleLoginRedirect(false)}
          disabled={isLoading}
        >
          {isLoading ? 'Connecting...' : 'Connect to User Account'}
        </button>

        <button 
          className="btn"
          onClick={() => handleLoginRedirect(true)}
          disabled={isLoading}
        >
          {isLoading ? 'Connecting...' : 'Connect to Team'}
        </button>
      </div>
    </div>
  );
} 