/**
 * AuthContext.jsx - Authentication Context Provider
 * This file implements the authentication context and provider for the Dropbox integration.
 * It handles user authentication, token management, and team-based authentication features.
 */

import React, { createContext, useContext, useState, useEffect } from 'react';
import { 
  createDropboxClient, 
  getTeamMembers,
  getCurrentAccount,
  getAdminMemberId
} from '../utils/dropboxClient';

/**
 * Dropbox configuration object containing client ID and redirect URI
 * Values are loaded from environment variables
 */
export const DROPBOX_CONFIG = {
  clientId: import.meta.env.VITE_DROPBOX_APP_KEY,
  redirectUri: import.meta.env.VITE_DROPBOX_REDIRECT_URI,
};

/**
 * Custom hook that syncs state with localStorage
 * @param {string} key - localStorage key
 * @param {any} initialValue - Initial value if no value exists in localStorage
 * @returns {[any, Function]} - State value and setter function
 */
function useLocalStorage(key, initialValue) {
  // Initialize state with value from localStorage or initial value
  const [value, setValue] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Update localStorage when state changes
  useEffect(() => {
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (error) {
      console.error(`Error writing to localStorage key "${key}":`, error);
    }
  }, [key, value]);

  return [value, setValue];
}

// Create the authentication context
const AuthContext = createContext(null);

/**
 * AuthProvider Component
 * Manages authentication state and provides authentication-related functionality
 * to the entire application through React Context.
 * 
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.children - Child components to be wrapped with auth context
 */
export function AuthProvider({ children }) {
  // Authentication state management
  const [accessToken, setAccessToken] = useLocalStorage('dropboxAccessToken', null);
  const [refreshToken, setRefreshToken] = useLocalStorage('dropboxRefreshToken', null);
  const [dropboxClient, setDropboxClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasOfflineAccess, setHasOfflineAccess] = useLocalStorage('hasOfflineAccess', false);
  
  // Team authentication state management
  const [isTeamAuth, setIsTeamAuth] = useLocalStorage('isTeamAuth', false);
  const [teamMembers, setTeamMembers] = useLocalStorage('teamMembers', []);
  const [selectedMember, setSelectedMember] = useLocalStorage('selectedMember', null);
  const [rootNamespaceId, setRootNamespaceId] = useLocalStorage('rootNamespaceId', null);
  const [isViewingRoot, setIsViewingRoot] = useLocalStorage('isViewingRoot', false);
  const [currentPath, setCurrentPath] = useLocalStorage('currentPath', '');
  const [pathKey, setPathKey] = useState(0);
  const [isLoadingTeamMembers, setIsLoadingTeamMembers] = useState(false);
  // Add currentAccount to state
  const [currentAccount, setCurrentAccount] = useState(null);

  /**
   * Effect hook for initializing the Dropbox client
   * Handles both individual and team-based authentication
   */
  useEffect(() => {
    if (!accessToken) {
      setLoading(false);
      return;
    }

    // Create client for team member access
    if (isTeamAuth && selectedMember) {
      const memberId = selectedMember.teamMemberId;
      
      // Always get the current member's account info to get the correct root namespace ID.
      const tempClient = createDropboxClient(accessToken, refreshToken, true, memberId);
      getCurrentAccount(tempClient)
        .then(account => {
          setCurrentAccount(account);
          const currentMemberRootNamespaceId = account.root_info.root_namespace_id;
          
          // Calculate the pathRoot for the API call right here, with the fresh ID.
          const correctPathRoot = isViewingRoot && currentMemberRootNamespaceId
            ? JSON.stringify({ ".tag": "root", "root": currentMemberRootNamespaceId })
            : null;

          // Update the global rootNamespaceId for the UI and subsequent renders.
          if (rootNamespaceId !== currentMemberRootNamespaceId) {
            setRootNamespaceId(currentMemberRootNamespaceId);
          }
          const finalClient = createDropboxClient(accessToken, refreshToken, true, memberId, correctPathRoot);
          setDropboxClient(finalClient);
        })
        .catch(err => {
          console.error("Could not get account info for selected member. Proceeding without path root.", err);

          // If the error is 401, it means the token is invalid for this action.
          // The best course of action is to log out to force re-authentication.
          if (err?.status === 401) {
            handleLogout();
            return; // Stop further execution in this broken state
          }
          
          setRootNamespaceId('');
          const finalClient = createDropboxClient(accessToken, refreshToken, true, memberId, null);
          setDropboxClient(finalClient);
        })
        .finally(() => {
          setLoading(false);
        });
      
      return;
    }

    // Initialize team authentication and fetch members
    if (isTeamAuth) {
      const basicClient = createDropboxClient(accessToken, refreshToken);
      setIsLoadingTeamMembers(true);
      
      Promise.all([getTeamMembers(basicClient), getAdminMemberId(basicClient)])
        .then(([members, adminMemberId]) => {
          setTeamMembers(members);
          
          if (members.length > 0 && !selectedMember) {
            const adminMember = members.find(m => m.teamMemberId === adminMemberId);
            setSelectedMember(adminMember || members[0]);
          } else {
            setLoading(false);
          }
        })
        .catch(error => {
          console.error('Failed to fetch team members:', error);
          setLoading(false);
        })
        .finally(() => {
          setIsLoadingTeamMembers(false);
        });
      return;
    }

    // Create client for individual user access
    if (!isTeamAuth) {
      const tempClient = createDropboxClient(accessToken, refreshToken);
      getCurrentAccount(tempClient).then(account => {
        setCurrentAccount(account); // Store the account info
        const currentRootNamespaceId = account.root_info.root_namespace_id;
        const homeNamespaceId = account.root_info.home_namespace_id;
        
        // Set rootNamespaceId regardless of whether it matches home namespace
        setRootNamespaceId(currentRootNamespaceId);
        
        // If it's a single user account (root matches home), ensure we're not in root view
        if (currentRootNamespaceId === homeNamespaceId) {
          setIsViewingRoot(false);
        }

        const correctPathRoot = isViewingRoot && currentRootNamespaceId
          ? JSON.stringify({ ".tag": "root", "root": currentRootNamespaceId })
          : null;
        
        const finalClient = createDropboxClient(accessToken, refreshToken, false, null, correctPathRoot);
        setDropboxClient(finalClient);
      }).catch(err => {
        console.error("Could not get account info for individual user.", err);

        if (err?.status === 401) {
          handleLogout();
          return;
        }

        setRootNamespaceId('');
        const finalClient = createDropboxClient(accessToken, refreshToken, false, null, null);
        setDropboxClient(finalClient);
      }).finally(() => {
        setLoading(false);
      });
    }
  }, [accessToken, isTeamAuth, selectedMember, isViewingRoot]);


  /**
   * Handles user login
   * Stores authentication data in state and local storage
   * 
   * @param {Object} authData - Authentication data from Dropbox
   * @param {boolean} offlineAccess - Whether offline access was requested
   */
  const handleLogin = (authData, offlineAccess = false) => {
    const { accessToken, refreshToken, teamId: newTeamId } = authData;
    const isTeam = !!newTeamId;

    // Clear any existing auth data from storage to prevent stale state
    handleLogout();

    setAccessToken(accessToken);
    setRefreshToken(refreshToken);
    setIsTeamAuth(isTeam);
    setHasOfflineAccess(offlineAccess);
  };

  /**
   * Handles user logout
   * Clears all authentication data from state and local storage
   */
  const handleLogout = () => {
    setAccessToken(null);
    setRefreshToken(null);
    setDropboxClient(null);
    setIsTeamAuth(false);
    setTeamMembers([]);
    setSelectedMember(null);
    setRootNamespaceId(null);
    setIsViewingRoot(false);
    setCurrentPath('');
    setHasOfflineAccess(false);
    setCurrentAccount(null);
  };

  /**
   * Switches the active team member
   * Creates a new Dropbox client for the selected team member
   * 
   * @param {Object} member - Selected team member information
   */
  const selectTeamMember = (member) => {
    if (!member || !isTeamAuth || !accessToken) return;
    setSelectedMember(member);
    setCurrentPath(''); // Reset path when switching members
    setPathKey(prev => prev + 1);
  };

  /**
   * Toggles between the user's home view and the root namespace view.
   * This is only available if the user is part of a team structure.
   */
  const toggleNamespaceView = () => {
    setIsViewingRoot(prev => !prev);
    setCurrentPath(''); // Reset path when toggling view
    setPathKey(prev => prev + 1);
  };

  /**
   * Triggers a reset of the pathKey, forcing a re-render of the FileBrowser component
   * to reset its currentPath state.
   */
  const triggerPathReset = () => {
    setPathKey(prev => prev + 1);
  };

  // Context value containing all authentication-related state and functions
  const value = {
    accessToken,
    refreshToken,
    dropboxClient,
    loading,
    handleLogin,
    handleLogout,
    isAuthenticated: !!accessToken,
    isTeamAuth,
    teamMembers,
    selectedMember,
    selectTeamMember,
    rootNamespaceId,
    isViewingRoot,
    toggleNamespaceView,
    pathKey,
    triggerPathReset,
    hasOfflineAccess,
    isLoadingTeamMembers,
    currentPath,
    setCurrentPath,
    currentAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Custom hook for accessing authentication context
 * @returns {Object} Authentication context value
 * @throws {Error} If used outside of AuthProvider
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
} 
