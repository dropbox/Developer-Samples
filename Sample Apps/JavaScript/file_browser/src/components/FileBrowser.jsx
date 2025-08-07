/**
 * FileBrowser.jsx - Main File Browser Interface
 * This component provides the main interface for browsing and managing Dropbox files.
 * It supports file/folder navigation, downloads, uploads, and sharing functionality.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faFolder, 
  faFile, 
  faDownload, 
  faShare, 
  faSpinner,
  faHome,
  faUpload,
  faUsers,
  faSignOutAlt
} from '@fortawesome/free-solid-svg-icons';
import {
  listFolder,
  downloadFile,
  uploadFile,
  formatBytes,
  formatDate,
  startLongPoll,
  getSharedLinkSettings,
  getChanges
} from '../utils/dropboxClient';
import './FileBrowser.css';
import ShareForm from './ShareForm';

// Toast Component
const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, 3000);

    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`toast ${type}`}>
      {message}
    </div>
  );
};

// Toast Context functionality integrated directly
const useToast = () => {
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
  }, []);

  const hideToast = useCallback(() => {
    setToast(null);
  }, []);

  return { toast, showToast, hideToast };
};

/**
 * FileBrowser Component
 * Main component for browsing and managing Dropbox files and folders.
 * Supports both individual and team-based access.
 */
export default function FileBrowser() {
  // Authentication and user context
  const { 
    dropboxClient, 
    handleLogout, 
    isTeamAuth, 
    teamMembers, 
    selectedMember, 
    selectTeamMember,
    isViewingRoot,
    toggleNamespaceView,
    rootNamespaceId,
    isLoadingTeamMembers,
    currentPath,
    setCurrentPath,
    currentAccount
  } = useAuth();

  // Component state
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [cursor, setCursor] = useState(null);
  const longPollTimeoutRef = useRef(null);
  const isPollingRef = useRef(false);
  const backoffTimeoutRef = useRef(null);
  const [shareFormOpen, setShareFormOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState(null);
  const [existingShareSettings, setExistingShareSettings] = useState(null);
  const { toast, showToast, hideToast } = useToast();

  // Load folder contents when path, client, or selected member changes
  useEffect(() => {
    if (dropboxClient) {
      loadCurrentFolder();
    }
    return () => {
      // Cleanup timeouts on unmount or path change
      if (longPollTimeoutRef.current) {
        clearTimeout(longPollTimeoutRef.current);
      }
      if (backoffTimeoutRef.current) {
        clearTimeout(backoffTimeoutRef.current);
      }
    };
  }, [currentPath, dropboxClient]); 

  // Start long polling when cursor changes
  useEffect(() => {
    if (cursor && dropboxClient && !isPollingRef.current) {
      startLongPolling();
    }
    return () => {
      isPollingRef.current = false;
    };
  }, [cursor, dropboxClient]);

  /**
   * Starts the long polling process to monitor folder changes
   */
  async function startLongPolling() {
    if (!cursor || isPollingRef.current) return;

    isPollingRef.current = true;
    try {
      const result = await startLongPoll(cursor);
      
      if (result.changes) {
        // Instead of reloading the entire folder, fetch only the changes
        try {
          const changes = await getChanges(dropboxClient, cursor);
          
          // Update the entries state by processing the changes
          setEntries(prevEntries => {
            const entriesMap = new Map(prevEntries.map(entry => [entry.path_lower, entry]));
            
            // Process each change
            changes.entries.forEach(change => {
              if (change['.tag'] === 'deleted') {
                // Remove deleted entries
                entriesMap.delete(change.path_lower);
              } else {
                // Add or update modified entries
                entriesMap.set(change.path_lower, change);
              }
            });
            
            // Convert back to array and maintain sorting
            return Array.from(entriesMap.values()).sort((a, b) => {
              if (a['.tag'] === 'folder' && b['.tag'] !== 'folder') return -1;
              if (a['.tag'] !== 'folder' && b['.tag'] === 'folder') return 1;
              return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });
          });
          
          // Update cursor for next polling cycle
          setCursor(changes.cursor);
        } catch (error) {
          // If getting changes fails, fall back to full reload
          console.error('Error getting changes, falling back to full reload:', error);
          await loadCurrentFolder();
        }
      }

      // Handle backoff if specified
      if (result.backoff) {
        isPollingRef.current = false;
        backoffTimeoutRef.current = setTimeout(() => {
          startLongPolling();
        }, result.backoff * 1000);
      } else {
        // No changes, continue polling after a short delay
        longPollTimeoutRef.current = setTimeout(() => {
          startLongPolling();
        }, 1000);
      }
    } catch (error) {
      console.error('Long polling error:', error);
      // On error, retry after a delay
      isPollingRef.current = false;
      longPollTimeoutRef.current = setTimeout(() => {
        startLongPolling();
      }, 5000); // 5 second delay on error
    }
  }

  /**
   * Loads the contents of the current folder
   * Updates entries state with files and folders
   */
  async function loadCurrentFolder() {
    try {
      setLoading(true);
      setError(null);

      const result = await listFolder(dropboxClient, currentPath);
      setEntries(result.entries);
      setCursor(result.cursor);
    } catch (error) {
      // Handle specific API errors
      const nestedError = error?.error?.error;
      if (nestedError?.['.tag'] === 'path') {
        const pathErrorTag = nestedError.path['.tag'];
        if (pathErrorTag === 'not_found') {
          showToast('The specified file or folder was not found');
          handleNavigateUp();
        } else if (pathErrorTag === 'malformed_path') {
          showToast('The specified path is invalid');
          setCurrentPath(''); // Return to root
        } 
      } else {
        setError('Failed to load folder contents. Please try again.');
        showToast('Failed to load folder contents', 'error');
      }
    } finally {
      setLoading(false);
    }
  }
  /**
   * Handles file download
   * Creates a temporary download link and triggers browser download
   * 
   * @param {string} path - File path in Dropbox
   * @param {string} filename - Name of the file to download
   */
  async function handleDownload(path, filename) {
    try {
      const file = await downloadFile(dropboxClient, path);
      const downloadUrl = window.URL.createObjectURL(file.fileBlob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
      showToast(`File "${filename}" downloaded successfully`, 'success');
    } catch (error) {
      const nestedError = error?.error?.error;
      if (nestedError?.['.tag'] === 'path') {
        const pathErrorTag = nestedError.path['.tag'];
        if (pathErrorTag === 'not_found') {
          showToast('The file no longer exists');
          loadCurrentFolder(); // Refresh the folder to update the UI
        } else {
          showToast('Failed to download file '+ error.message, 'error');
        }
      } else {
        showToast('Failed to download file '+ error.message, 'error');
      }
    }
  }

  /**
   * Handles file upload
   * Uploads selected file to current Dropbox folder
   * 
   * @param {Event} event - File input change event
   */
  async function handleUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setUploading(true);
      await uploadFile(dropboxClient, currentPath, file);
      showToast(`File "${file.name}" uploaded successfully`, 'success');
      loadCurrentFolder();
    } catch (error) {
        showToast('Failed to upload file: ' + error.message, 'error');
    } finally {
      setUploading(false);
      event.target.value = null;
    }
  }

  /**
   * Handles opening the share form for a file/folder
   * @param {string} path - The path of the file/folder to share
   */
  async function handleShare(path) {
    setSelectedPath(path);

    try {
      const existingSettings = await getSharedLinkSettings(dropboxClient, path);
      setExistingShareSettings(existingSettings);
    } catch (error) {
      // If there's an error, log it and reset the settings
      console.error('Error fetching shared link settings:', error);
      setExistingShareSettings(null);
      showToast('Could not fetch existing share settings.', 'error');
    }
    setShareFormOpen(true);
  }

  /**
   * Handles closing the share form
   */
  function handleCloseShareForm() {
    setShareFormOpen(false);
    setSelectedPath(null);
    setExistingShareSettings(null);
  }

  /**
   * Navigates to a folder
   * @param {string} path - Target folder path
   */
  function handleFolderClick(path) {
    setCurrentPath(path);
  }

  /**
   * Navigates to parent folder
   */
  function handleNavigateUp() {
    if (!currentPath) return;
    const parentPath = currentPath.split('/').slice(0, -1).join('/');
    setCurrentPath(parentPath);
  }

  /**
   * Generates breadcrumb navigation items
   * @returns {string[]} Array of path segments
   */
  function getBreadcrumbs() {
    if (!currentPath) return [];
    return currentPath.split('/').filter(Boolean);
  }

  /**
   * Handles navigation through breadcrumbs
   * @param {number} index - The index in the path array to navigate to
   */
  const handleBreadcrumbClick = (index) => {
    const pathParts = currentPath.split('/').filter(Boolean);
    const newPath = index === -1 ? '' : '/' + pathParts.slice(0, index + 1).join('/');
    setCurrentPath(newPath);
  };

  // Display error state if loading failed
  if (error) {
    return (
      <div className="error-container">
        <p className="error-message">{error}</p>
        <button onClick={loadCurrentFolder} className="btn btn-success">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="file-browser">
      {/* Top bar with title and user controls */}
      <div className="top-bar">
        <h2>Dropbox File Browser</h2>
        <div className="top-bar-actions">
          {/* Namespace view toggle */}
          <div className="namespace-toggle">
            <label className="switch">
              <input 
                type="checkbox"
                checked={isViewingRoot}
                onChange={toggleNamespaceView}
                disabled={!currentAccount|| rootNamespaceId === currentAccount.root_info.home_namespace_id}
              />
              <span className="slider round"></span>
            </label>
            <span>Team Space</span>
          </div>

          {/* Team member selector for team accounts */}
          {isTeamAuth && (
            <div className="team-selector">
              <FontAwesomeIcon icon={faUsers} className="team-icon" />
              {isLoadingTeamMembers ? (
                <div className="team-loading">
                  <FontAwesomeIcon icon={faSpinner} spin /> Loading team members...
                </div>
              ) : teamMembers.length > 0 ? (
                <select
                  value={selectedMember?.teamMemberId || ''}
                  onChange={(e) => {
                    const member = teamMembers.find(m => m.teamMemberId === e.target.value);
                    if (member) {
                      selectTeamMember(member);
                    }
                  }}
                >
                  {teamMembers.map((member) => (
                    <option key={member.teamMemberId} value={member.teamMemberId}>
                      {member.name} ({member.email})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="team-error">No team members found</div>
              )}
            </div>
          )}
          <button onClick={handleLogout} className="btn btn-secondary">
            <FontAwesomeIcon icon={faSignOutAlt} /> Logout
          </button>
        </div>
      </div>

      {/* Navigation bar with breadcrumbs */}
      <div className="navigation-bar">
        <button 
          onClick={() => setCurrentPath('')}
          className="btn btn-secondary btn-icon"
          title="Go to root"
        >
          <FontAwesomeIcon icon={faHome} />
        </button>
        {currentPath && (
          <button 
            onClick={handleNavigateUp}
            className="btn btn-secondary btn-icon"
            title="Go up one level"
          >
            ..
          </button>
        )}
        <div className="breadcrumbs">
          {getBreadcrumbs().map((part, index, array) => (
            <span key={index}>
              <span 
                className="breadcrumb-part"
                onClick={() => handleBreadcrumbClick(index)}
              >
                {part}
              </span>
              {index < array.length - 1 && ' / '}
            </span>
          ))}
        </div>
      </div>

      {/* File upload section */}
      <div className="upload-section">
        <input
          type="file"
          onChange={handleUpload}
          disabled={uploading}
          id="file-upload"
          className="file-input"
        />
        <label htmlFor="file-upload" className="btn">
          {uploading ? (
            <><FontAwesomeIcon icon={faSpinner} spin /> Uploading...</>
          ) : (
            <><FontAwesomeIcon icon={faUpload} /> Upload File</>
          )}
        </label>
      </div>

      {/* File and folder list */}
      <div className="file-list">
        {loading ? (
          <div className="loading">
            <FontAwesomeIcon icon={faSpinner} spin /> Loading...
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-folder">This folder is empty</div>
        ) : (
          <>
            <div className="file-list-header">
              <div className="header-name">Name</div>
              <div className="header-size">Size</div>
              <div className="header-modified">Modified</div>
              <div className="header-actions" />
            </div>
            {entries.map((entry) => (
              <div key={entry.id} className="file-item">
                <div className="file-info">
                  <FontAwesomeIcon
                    icon={entry['.tag'] === 'folder' ? faFolder : faFile}
                    className={entry['.tag'] === 'folder' ? 'folder-icon' : 'file-icon'}
                  />
                  <span
                    className={`file-name ${entry['.tag'] === 'folder' ? 'folder-name' : ''}`}
                    onClick={() => entry['.tag'] === 'folder' && handleFolderClick(entry.path_lower)}
                  >
                    {entry.name}
                  </span>
                </div>
                {entry['.tag'] === 'file' ? (
                  <>
                    <span className="file-size">{formatBytes(entry.size)}</span>
                    <span className="file-modified">{formatDate(entry.server_modified)}</span>
                  </>
                ) : (
                  <>
                    <span className="file-size">--</span>
                    <span className="file-modified">--</span>
                  </>
                )}
                <div className="file-actions">
                  {entry['.tag'] === 'file' && (
                    <>
                      <button
                        onClick={() => handleDownload(entry.path_lower, entry.name)}
                        title="Download"
                        className="btn btn-secondary btn-icon"
                      >
                        <FontAwesomeIcon icon={faDownload} />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleShare(entry.path_lower)}
                    title="Share"
                    className="btn btn-secondary btn-icon"
                  >
                    <FontAwesomeIcon icon={faShare} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Share Form */}
      <ShareForm
        isOpen={shareFormOpen}
        onClose={handleCloseShareForm}
        path={selectedPath}
        dropboxClient={dropboxClient}
        existingSettings={existingShareSettings}
        showToast={showToast}
      />
      {/* Toast component */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={hideToast}
        />
      )}
    </div>
  );
} 