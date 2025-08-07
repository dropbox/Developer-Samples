/**
 * dropboxClient.js - Dropbox API Integration Utilities
 * This file provides utility functions for interacting with the Dropbox API,
 * including authentication, file operations, and team management.
 */

import { Dropbox, DropboxAuth } from 'dropbox';

// ============================================================================
// Authentication Utilities
// ============================================================================

/**
 * Generates the OAuth authorization URL
 * @param {string} clientId - Dropbox API client ID
 * @param {string} redirectUri - OAuth redirect URI
 * @param {boolean} offlineAccess - Whether to request offline access (refresh token)
 * @param {boolean} teamAuth - Whether to request team-level access
 * @returns {Promise<string>} Authorization URL
 */
export async function getAuthUrl(clientId, redirectUri, offlineAccess = false, teamAuth = false) {
  const dbxAuth = new DropboxAuth({ clientId });
  const tokenAccessType = offlineAccess ? 'offline' : 'online';

  const scopes = [
    'account_info.read', // For accessing user account information
    'files.metadata.read', // For listing files and folders
    'files.content.read', // For downloading files
    'files.content.write', // For uploading files
    'sharing.write', // For creating and modifying shared links
    'sharing.read' // For reading shared link metadata
  ];

  let includeGrantedScopes;
  if (teamAuth) {
    scopes.push(
      'team_info.read', // For accessing team information
      'members.read', // For listing team members
      'team_data.member' // For switching between team members
    );
    includeGrantedScopes = 'team';
  }
  
  const authUrl = await dbxAuth.getAuthenticationUrl(
    redirectUri,
    undefined,
    'code',
    tokenAccessType,
    scopes,
    includeGrantedScopes,
    true 
  );
  
  const codeVerifier = await dbxAuth.getCodeVerifier();
  sessionStorage.setItem('codeVerifier', codeVerifier);
  return authUrl;
}

/**
 * Exchanges an OAuth code for access and refresh tokens
 * @param {string} clientId - Dropbox API client ID
 * @param {string} code - OAuth authorization code
 * @param {string} redirectUri - OAuth redirect URI
 * @returns {Promise<Object>} Token response object
 */
export async function getTokensFromCode(clientId, code, redirectUri) {
  const codeVerifier = sessionStorage.getItem('codeVerifier');
  if (!codeVerifier) {
    throw new Error('No code verifier found in session storage');
  }

  sessionStorage.removeItem('codeVerifier');

  const dbxAuth = new DropboxAuth({ clientId });
  await dbxAuth.setCodeVerifier(codeVerifier);

  try {
    const response = await dbxAuth.getAccessTokenFromCode(redirectUri, code);
    const { result } = response;

    if (!result.access_token) {
      throw new Error('Invalid token response: No access token received');
    }

    // Start with required properties and add optional ones if they exist.
    const tokenResponse = {
      accessToken: result.access_token,
      expiresIn: result.expires_in
    };

    if (result.refresh_token) {
      tokenResponse.refreshToken = result.refresh_token;
    }
    if (result.team_id) {
      tokenResponse.teamId = result.team_id;
    }
    if (result.account_id) {
      tokenResponse.accountId = result.account_id;
    }

    return tokenResponse;
  } catch (error) {
    console.error('Token exchange error:', error);
    throw error;
  }
}

// ============================================================================
// Dropbox Client Operations
// ============================================================================

/**
 * Creates a Dropbox API client instance
 * @param {string} accessToken - OAuth access token
 * @param {string} [refreshToken] - Optional refresh token for automatic token refresh
 * @param {boolean} teamAuth - Whether this is a team auth client
 * @param {string} teamMemberId - Team member ID for member-specific operations
 * @param {string} pathRoot - Optional path root for team space access
 * @returns {Dropbox} Dropbox client instance
 */
export function createDropboxClient(
  accessToken,
  refreshToken = null,
  teamAuth = false,
  teamMemberId = null,
  pathRoot = null
) {
  const options = { 
    accessToken: accessToken,
    clientId: import.meta.env.VITE_DROPBOX_APP_KEY // Required for refresh token flow
  };

  // Add refresh token if available for automatic refresh
  if (refreshToken) {
    options.refreshToken = refreshToken;
  }

  if (teamAuth && teamMemberId) {
    options.selectUser = teamMemberId;
  }

  if (pathRoot) {
    options.pathRoot = pathRoot;
  }
  
  return new Dropbox(options);
}

/**
 * Fetches current user's account info
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @returns {Promise<Object>} Current user's account info
 */
export async function getCurrentAccount(dropboxClient) {
  try {
    const account = await dropboxClient.usersGetCurrentAccount();
    return account.result;
  } catch (error) {
    console.error('Failed to get current account:', error);
    throw error;
  }
}

/**
 * Fetches team members list
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @returns {Promise<Array>} List of team members
 */
export async function getTeamMembers(dropboxClient) {
  try {
    let allMembers = [];
    let response = await dropboxClient.teamMembersListV2({ limit: 100 });
    allMembers = allMembers.concat(response.result.members);

    while (response.result.has_more) {
      response = await dropboxClient.teamMembersListContinueV2({
        cursor: response.result.cursor,
      });
      allMembers = allMembers.concat(response.result.members);
    }
    
    return allMembers.map(member => ({
      accountId: member.profile.account_id,
      email: member.profile.email,
      name: member.profile.name.display_name,
      teamMemberId: member.profile.team_member_id
    }));
  } catch (error) {
    console.error('Failed to get team members:', error);
    throw error;
  }
}

/**
 * Get the authenticated admin's member ID.
 * @param {DropboxTeam} dbxTeam - DropboxTeam instance.
 * @returns {Promise<string>} The admin's team member ID.
 */
export async function getAdminMemberId(dbxTeam) {
  try {
    const adminProfile = await dbxTeam.teamTokenGetAuthenticatedAdmin();
    return adminProfile.result.admin_profile.team_member_id;
  } catch (error) {
    console.error('Failed to get admin member ID:', error);
    throw error;
  }
}

/**
 * Lists contents of a Dropbox folder with proper pagination and caching
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} path - Folder path to list
 * @returns {Promise<Object>} Folder contents with entries and cursor
 */
export async function listFolder(dropboxClient, path = '') {
  try {
    let allEntries = [];
    let response = await dropboxClient.filesListFolder({ 
      path,
      include_deleted: false
    });
    
    allEntries = allEntries.concat(response.result.entries);

    // Handle pagination
    while (response.result.has_more) {
      response = await dropboxClient.filesListFolderContinue({
        cursor: response.result.cursor
      });
      allEntries = allEntries.concat(response.result.entries);
    }

    return {
      entries: allEntries.sort((a, b) => {
        // Keep existing sorting logic
        if (a['.tag'] === 'folder' && b['.tag'] !== 'folder') return -1;
        if (a['.tag'] !== 'folder' && b['.tag'] === 'folder') return 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }),
      cursor: response.result.cursor // Keep cursor for long polling
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Downloads a file from Dropbox
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} path - Path to the file
 * @returns {Promise<Object>} File download result
 */
export async function downloadFile(dropboxClient, path) {
  try {
    const response = await dropboxClient.filesDownload({ path });
    return response.result;
  } catch (error) {
    console.error('Error downloading file:', error);
    throw error;
  }
}

/**
 * Uploads a file to Dropbox
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} path - Destination path
 * @param {File} file - File object to upload
 * @returns {Promise<Object>} Upload result
 */
export async function uploadFile(dropboxClient, path, file) {
  
  try {
    // It is recommended to keep chunk size as multiple of 4MB
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB chunks
    const targetPath = `${path}/${file.name}`;
    // Use chunked upload for files larger than 150MB
    if (file.size > 150 * 1024 * 1024) {
      // Start upload session
      const firstChunk = file.slice(0, CHUNK_SIZE);
      const sessionStart = await dropboxClient.filesUploadSessionStart({
        close: false,
        contents: firstChunk
      });

      let offset = firstChunk.size;
      const sessionId = sessionStart.result.session_id;

      // Upload the remaining chunks
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const cursor = {
          session_id: sessionId,
          offset: offset
        };

        // If this is the last chunk, finish the session
        if (offset + chunk.size >= file.size) {
          const commitInfo = {
            path: targetPath,
            mode: { '.tag': 'add' },
            autorename: true
          };

          const response = await dropboxClient.filesUploadSessionFinish({
            cursor: cursor,
            commit: commitInfo,
            contents: chunk
          });
          return response.result;
        } else {
          // Upload intermediate chunk
          await dropboxClient.filesUploadSessionAppendV2({
            cursor: cursor,
            close: false,
            contents: chunk
          });
          offset += chunk.size;
        }
      }
    } else {
      // Use simple upload for small files
      const response = await dropboxClient.filesUpload({
        path: targetPath,
        contents: file,
        mode: { '.tag': 'add' },
        autorename: true,
      });
      return response.result;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
}

/**
 * Gets existing shared link settings for a path
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} path - Path to check
 * @returns {Promise<Object|null>} Shared link settings or null if no link exists
 */
export async function getSharedLinkSettings(dropboxClient, path) {
  try {
    const response = await dropboxClient.sharingListSharedLinks({
      path,
      direct_only: true
    });

    const viewerLinks = response.result.links.filter(link => 
      link.link_permissions.link_access_level['.tag'] === 'viewer'
    );
    if (viewerLinks.length > 0) {
      const link = viewerLinks[0];
      const settings = {};

      // Extract link permissions
      if (link.link_permissions) {
        settings.allow_download = link.link_permissions.allow_download;
        settings.require_password = link.link_permissions.require_password;

        // Get audience type
        if (link.link_permissions.effective_audience) {
          const visibility = link.link_permissions.effective_audience['.tag'];
          if (visibility === 'team') settings.audience = 'team';
          else if (visibility === 'public') settings.audience = 'public';
          else if (visibility === 'no_one') settings.audience = 'no_one';
          else if (visibility === 'password') settings.audience = 'password';
          else if (visibility === 'members') settings.audience = 'members';
          else settings.audience = 'public'; // default
        }
      }

      // Check expiration
      if (link.expires) {
        settings.expires = 'custom';
        settings.expiration_timestamp = link.expires.split('T')[0]; // Get just the date part
      } else {
        settings.expires = 'never';
      }

      return {
        url: link.url,
        settings
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting shared link settings:', error);
    throw error;
  }
}

/**
 * Creates shared link settings object from user input
 * @param {Object} settings - User settings
 * @returns {Object} Dropbox API compatible settings object
 */
function createLinkSettings(settings) {
  const linkSettings = {
    access: { '.tag': 'viewer' }  // Always set to viewer access
  };

  // Handle download permissions
  if (typeof settings.allow_download === 'boolean') {
    linkSettings.allow_download = settings.allow_download;
  }

  // Set audience (who can access)
  switch (settings.audience) {
    case 'team':
      linkSettings.audience = { '.tag': 'team' };
      break;
    case 'no_one':
      linkSettings.audience = { '.tag': 'no_one' };
      break;
    case 'password':
      linkSettings.audience = { '.tag': 'password' };
      break;
    case 'members':
      linkSettings.audience = { '.tag': 'members' };
      break;
    case 'other':
      linkSettings.audience = { '.tag': 'other' };
      break;
    default:
      linkSettings.audience = { '.tag': 'public' };
  }
  
  // Configure password protection
  if (typeof settings.require_password == 'boolean') {
    linkSettings.require_password = settings.require_password;
    if (settings.require_password) {
      if (!settings.link_password) {
        throw new Error('Password is required when password protection is enabled');
      }
      linkSettings.link_password = settings.link_password;
    } else {
      linkSettings.require_password = false;
      linkSettings.link_password = null;
    }
  }

  // Handle expiration
  if (settings.expires && settings.expires !== 'never') {
    let expiryDate;
    
    if (settings.expires === 'custom' && settings.expiration_timestamp) {
      // For custom dates, use the provided timestamp and ensure it's treated as UTC end of day
      expiryDate = new Date(`${settings.expiration_timestamp}T23:59:59Z`);
    } else {
      // For preset options (1, 7, 30 days)
      const days = parseInt(settings.expires);
      if (!isNaN(days)) {
        expiryDate = new Date();
        expiryDate.setUTCDate(expiryDate.getUTCDate() + days);
        expiryDate.setUTCHours(23, 59, 59, 999);
      }
    }

    if (expiryDate && !isNaN(expiryDate.getTime())) {
      linkSettings.expires = expiryDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }

  return linkSettings;
}

/**
 * Creates a new shared link
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} path - Path to share
 * @param {Object} settings - Share settings
 * @returns {Promise<Object>} Share result
 */
export async function createSharedLink(dropboxClient, path, settings) {
  const linkSettings = createLinkSettings(settings);
  
  try {
    const response = await dropboxClient.sharingCreateSharedLinkWithSettings({
      path,
      settings: linkSettings
    });
    return {
      url: response.result.url
    };
  } catch (error) {
    // If the link already exists, try to get it and update its settings
    if (error?.error?.['.tag'] === 'shared_link_already_exists') {
      const links = await dropboxClient.sharingListSharedLinks({
        path,
        direct_only: true
      });
      
      if (links.result.links.length > 0) {
        const existingLink = links.result.links[0];
        return await updateSharedLink(dropboxClient, existingLink.url, settings);
      }
    }
    throw error;
  }
}

/**
 * Updates an existing shared link
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} url - Existing shared link URL
 * @param {Object} settings - New settings
 * @returns {Promise<Object>} Update result
 */
export async function updateSharedLink(dropboxClient, url, settings) {
  if (!url) {
    throw new Error('URL is required to update shared link settings');
  }

  const linkSettings = createLinkSettings(settings);
  const response = await dropboxClient.sharingModifySharedLinkSettings({
    url,
    settings: linkSettings,
    remove_expiration: !settings.expires
  });
  return {
    url: response.result.url
  };
}

/**
 * Revokes (deletes) a shared link
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} url - URL of the shared link to revoke
 * @returns {Promise<Object>} Revoke result
 */
export async function revokeSharedLink(dropboxClient, url) {
  if (!url) {
    throw new Error('URL is required to revoke a shared link');
  }

  await dropboxClient.sharingRevokeSharedLink({ url });
  return {
    message: 'Shared link revoked successfully'
  };
}

/**
 * Starts a long polling request to monitor folder changes
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} cursor - The cursor from listFolder or listFolderContinue
 * @param {number} timeout - Optional timeout in seconds (default: 30)
 * @returns {Promise<Object>} Long poll result with changes flag
 */
export async function startLongPoll(cursor, timeout = 30) {
  try {
    // Create a new Dropbox instance specifically for long polling, because the longpoll endpoint is noAuth
    const longpollClient = new Dropbox();
    const response = await longpollClient.filesListFolderLongpoll({
      cursor,
      timeout
    });
    return {
      changes: response.result.changes,
      backoff: response.result.backoff,
      trigger: response.result.trigger
    };
  } catch (error) {
    console.error('Long polling error:', error);
    throw error;
  }
}

/**
 * Gets folder changes since the last cursor
 * @param {Dropbox} dropboxClient - Dropbox client instance
 * @param {string} cursor - The cursor from previous listing
 * @returns {Promise<Object>} Changes with entries and new cursor
 */
export async function getChanges(dropboxClient, cursor) {
  try {
    let allChanges = [];
    let response = await dropboxClient.filesListFolderContinue({ cursor });
    allChanges = allChanges.concat(response.result.entries);

    // Handle pagination of changes
    while (response.result.has_more) {
      response = await dropboxClient.filesListFolderContinue({
        cursor: response.result.cursor
      });
      allChanges = allChanges.concat(response.result.entries);
    }

    return {
      entries: allChanges,
      cursor: response.result.cursor
    };
  } catch (error) {
    console.error('Error getting changes:', error);
    throw error;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Formats bytes into human-readable size
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted size string
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Formats a timestamp into a localized date string
 * @param {string|number} timestamp - Timestamp to format
 * @returns {string} Formatted date string
 */
export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
} 