import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faCalendar, 
  faSpinner, 
  faCopy, 
  faTrash,
  faXmark
} from '@fortawesome/free-solid-svg-icons';
import { createSharedLink, updateSharedLink, revokeSharedLink } from '../utils/dropboxClient';
import './ShareForm.css';


class ShareFormErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ShareForm error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="share-form-overlay">
          <div className="share-form">
            <h2>Something went wrong</h2>
            <div className="error-message">
              {this.state.error?.message || 'An error occurred while loading the share form.'}
            </div>
            <div className="form-actions">
              <button onClick={this.props.onClose} className="btn btn-secondary">
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const ACCESS_OPTIONS = [
  { value: 'public', label: 'Anyone with the link' },
  { value: 'team', label: 'Team members only' },
  { value: 'no_one', label: 'No additional access' }
];

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'custom', label: 'Custom' }
];

function ShareFormContent({ 
  isOpen, 
  onClose, 
  path, 
  dropboxClient,
  existingSettings = null,
  showToast
}) {
  // Form state
  const [audience, setAudience] = useState(existingSettings?.settings?.audience || 'public');
  const [requirePassword, setRequirePassword] = useState(existingSettings?.settings?.require_password || false);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(existingSettings?.settings?.allow_download !== false);
  const [expires, setExpires] = useState(existingSettings?.settings?.expires || 'never');
  const [expirationTimestamp, setExpirationTimestamp] = useState(existingSettings?.settings?.expiration_timestamp || '');
  const [sharedLink, setSharedLink] = useState(existingSettings?.url || '');
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // Remove useToast hook since we're getting it as a prop

  useEffect(() => {
    if (existingSettings) {
      setAudience(existingSettings.settings.audience || 'public');
      setRequirePassword(existingSettings.settings.require_password || false);
      setAllowDownload(existingSettings.settings.allow_download !== false);
      setExpires(existingSettings.settings.expires || 'never');
      setExpirationTimestamp(existingSettings.settings.expiration_timestamp || '');
      setSharedLink(existingSettings.url || '');
    }
  }, [existingSettings]);

  const handleCreateLink = async () => {
    try {
      setLoading(true);
      setError(null);

      // Validate password if password protection is enabled
      if (requirePassword && !password) {
        setError('Password is required when password protection is enabled');
        return;
      }

      // Validate expiration date for custom expiry
      if (expires === 'custom') {
        if (!expirationTimestamp) {
          setError('Please select an expiration date');
          return;
        }
        const selectedDate = new Date(expirationTimestamp);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (selectedDate < today) {
          setError('Expiration date cannot be in the past');
          return;
        }
      }

      const settings = {
        audience: audience,
        require_password: requirePassword,
        link_password: requirePassword ? password : undefined,
        allow_download: allowDownload,
        expires: expires === 'never' ? null : expires,
        expiration_timestamp: expires === 'custom' ? expirationTimestamp : null
      };

      const result = await createSharedLink(dropboxClient, path, settings);
      setSharedLink(result.url);
      setLinkCopied(false);
      showToast('Shared link created successfully', 'success');
    } catch (error) {
      if (error?.error?.error?.['.tag'] === 'path') {
        const pathErrorTag = error?.error?.error?.path['.tag'];
        if (pathErrorTag === 'not_found') {
          setError('The file or folder no longer exists');
          showToast('The file or folder no longer exists', 'error');
          onClose();
        } else if (pathErrorTag === 'malformed_path') {
          setError('The path is invalid');
          showToast('The path is invalid', 'error');
        }
      } else {
        setError('Failed to create shared link. Please try again.');
        showToast('Failed to create shared link', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateLink = async () => {
    try {
      setLoading(true);
      setError(null);

      // Validate password if password protection is enabled
      if (requirePassword && !password) {
        setError('Password is required when password protection is enabled');
        return;
      }

      // Validate expiration date for custom expiry
      if (expires === 'custom') {
        if (!expirationTimestamp) {
          setError('Please select an expiration date');
          return;
        }
        const selectedDate = new Date(expirationTimestamp);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (selectedDate < today) {
          setError('Expiration date cannot be in the past');
          return;
        }
      }

      const settings = {
        audience: audience,
        require_password: requirePassword,
        link_password: requirePassword ? password : undefined,
        allow_download: allowDownload,
        expires: expires === 'never' ? null : expires,
        expiration_timestamp: expires === 'custom' ? expirationTimestamp : null
      };

      const result = await updateSharedLink(dropboxClient, sharedLink, settings);
      setSharedLink(result.url);
      setLinkCopied(false);
      showToast('Share settings updated successfully', 'success');
    } catch (error) {
      if (error?.error?.error?.['.tag'] === 'shared_link_not_found') {
        setError('The shared link no longer exists. Create a new one.');
        showToast('The shared link no longer exists. Create a new one.', 'error');
        setSharedLink('');
      } else {
        setError('Failed to update share settings. Please try again.');
        showToast('Failed to update share settings', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeLink = async () => {
    try {
      setLoading(true);
      setError(null);

      await revokeSharedLink(dropboxClient, sharedLink);
      setSharedLink('');
      showToast('Shared link revoked successfully', 'success');
      onClose();
    } catch (error) {
      if (error?.error?.error?.['.tag'] === 'shared_link_not_found') {
        setSharedLink('');
        showToast('The shared link has already been revoked', 'success');
        onClose();
      } else {
        setError('Failed to revoke shared link. Please try again.');
        showToast('Failed to revoke shared link', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(sharedLink);
      setLinkCopied(true);
      showToast('Link copied to clipboard', 'success');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (error) {
      console.error('Error copying link:', error);
      setError('Failed to copy link to clipboard');
      showToast('Failed to copy link to clipboard', 'error');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="share-form-overlay" onClick={onClose}>
      <div className="share-form" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="close-button">
          <FontAwesomeIcon icon={faXmark} />
        </button>
        <h2>{sharedLink ? 'Update Sharing Settings' : 'Share File'}</h2>
        
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="form-group">
          <label>Who can access</label>
          <select 
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            disabled={loading}
          >
            {ACCESS_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="access-level-info">
            Access Level: Viewer (can only view and comment)
          </div>
        </div>

        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={requirePassword}
              onChange={(e) => {
                setRequirePassword(e.target.checked);
                if (!e.target.checked) {
                  setPassword('');
                }
              }}
              disabled={loading}
            />
            Password protect
          </label>
          {requirePassword && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              disabled={loading}
              className="password-input"
            />
          )}
        </div>

        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!allowDownload}
              onChange={(e) => setAllowDownload(!e.target.checked)}
              disabled={loading}
            />
            Disable download
          </label>
        </div>

        <div className="form-group">
          <label>Link expiry</label>
          <select
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            disabled={loading}
          >
            {EXPIRY_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {expires === 'custom' && (
            <div className="custom-date-input">
              <FontAwesomeIcon icon={faCalendar} />
              <input
                type="date"
                value={expirationTimestamp}
                onChange={(e) => setExpirationTimestamp(e.target.value)}
                disabled={loading}
                min={new Date().toISOString().split('T')[0]}
              />
            </div>
          )}
        </div>

        {sharedLink && (
          <div className="shared-link-container">
            <input
              type="text"
              value={sharedLink}
              readOnly
              className="shared-link-input"
            />
            <button
              onClick={handleCopyLink}
              className="btn btn-secondary"
              disabled={loading}
            >
              <FontAwesomeIcon icon={faCopy} />
              {linkCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        )}

        <div className="form-actions">
          {sharedLink ? (
            <button onClick={handleUpdateLink} className="btn btn-primary" disabled={loading}>
              {loading ? <FontAwesomeIcon icon={faSpinner} spin /> : 'Update Settings'}
            </button>
          ) : (
            <button onClick={handleCreateLink} className="btn btn-primary" disabled={loading}>
              {loading ? <FontAwesomeIcon icon={faSpinner} spin /> : 'Create Link'}
            </button>
          )}

          {sharedLink && (
            <button onClick={handleRevokeLink} className="btn btn-danger" disabled={loading}>
              <FontAwesomeIcon icon={faTrash} />
              Revoke Link
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ShareForm(props) {
  if (!props.isOpen) return null;
  
  return createPortal(
    <ShareFormErrorBoundary onClose={props.onClose}>
      <ShareFormContent {...props} />
    </ShareFormErrorBoundary>,
    document.body
  );
} 