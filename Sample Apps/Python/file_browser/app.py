from flask import Flask, redirect, session, url_for, request, render_template, send_file
import dropbox
import os
import secrets
from dotenv import load_dotenv
import io
import posixpath
from functools import wraps
from datetime import datetime, timedelta, timezone

# Load environment variables
load_dotenv()

# Initialize Flask application
app = Flask(__name__)
# Generate a secure random secret key for session management
app.secret_key = secrets.token_hex(16)

# Add isinstance function to Jinja2 template environment for type checking in templates
app.jinja_env.globals.update(isinstance=isinstance)

# Dropbox API credentials from environment variables
DROPBOX_APP_KEY = os.getenv('DROPBOX_APP_KEY')
DROPBOX_APP_SECRET = os.getenv('DROPBOX_APP_SECRET')
DROPBOX_REDIRECT_URI = os.getenv('DROPBOX_REDIRECT_URI')

def handle_dropbox_errors(f):
    """
    Error handler for Dropbox API operations.
    
    Handles common Dropbox SDK exceptions:
    - AuthError: When access token is invalid or expired
    - ApiError: For various API-related errors
    
    For more exception types, see: https://dropbox-sdk-python.readthedocs.io/en/latest/api/exceptions.html
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except dropbox.exceptions.AuthError:
            # Handle authentication errors by redirecting to login
            session.clear()
            return redirect(url_for('login', auth_type=kwargs.get('auth_type', 'user')))
        except dropbox.exceptions.ApiError as e:
            # Handle Dropbox API-specific errors
            if (e.error.is_invalid_account_type() and 
                e.error.get_invalid_account_type().is_feature()):
                return e.user_message_text, 403
            return f"Dropbox API Error: {str(e)}", 500
        except Exception as e:
            return f"Error: {str(e)}", 500
    return decorated_function

def get_auth_flow(token_access_type='online', auth_type='user'):
    """
    Configure Dropbox OAuth 2 authentication flow.
    
    The OAuth 2 flow is used to obtain access tokens for making API calls.
    To learn more about the OAuth 2 flow and scopes, see: https://www.dropbox.com/developers/reference/oauth-guide
    
    Args:
        token_access_type: 
            - 'online': Get access token only (default)
            - 'offline': Get refresh token for long-term access (when checkbox is checked)
        auth_type: 
            - 'user': Account access (on any plan)
            - 'team': Entire team access
    """
    # Define required API scopes based on authentication type
    scopes = [
        'account_info.read',     # For accessing user account information
        'files.metadata.read',   # For listing files and folders
        'files.content.read',    # For downloading files
        'files.content.write',   # For uploading files
        'sharing.write',         # For creating and modifying shared links
        'sharing.read'           # For reading shared link metadata
    ]
    
    # Add team-specific scopes for team authentication
    if auth_type == 'team':
        scopes += [
            'team_info.read',    # For accessing team information
            'team_data.member',  # For switching between team members
            'members.read'       # For listing team members
        ]
    
    return dropbox.oauth.DropboxOAuth2Flow(
        consumer_key=DROPBOX_APP_KEY,
        consumer_secret=DROPBOX_APP_SECRET,
        redirect_uri=DROPBOX_REDIRECT_URI,
        session=session,
        csrf_token_session_key='dropbox-auth-csrf-token',
        scope=scopes,
        token_access_type=token_access_type
    )

@handle_dropbox_errors
def get_team_members(dbx_team):
    """
    List all active members in a Dropbox team.
    
    Uses the Dropbox Team API to list members:
    https://www.dropbox.com/developers/documentation/http/teams#team-members-list
    
    Handles pagination for teams with many members using team_members_list_continue_v2 (API v2).

    Args:
        dbx_team: DropboxTeam instance with admin privileges
        
    Returns:
        list: Active team members with their profiles
    """
    members_result = dbx_team.team_members_list_v2()
    team_members = [m for m in members_result.members 
                    if m.profile.status == dropbox.team.TeamMemberStatus.active]
    
    # Handle pagination for large teams
    while members_result.has_more:
        members_result = dbx_team.team_members_list_continue_v2(members_result.cursor)
        team_members.extend([m for m in members_result.members 
                            if m.profile.status == dropbox.team.TeamMemberStatus.active])
    return team_members

def get_admin_member_id(dbx_team):
    """Get the authenticated admin's member ID."""
    admin_profile = dbx_team.team_token_get_authenticated_admin()
    return admin_profile.admin_profile.team_member_id

def get_dropbox_client(auth_type='user', root='home', member_id=None):
    """
    Create an authenticated Dropbox client instance.
    
    The returned client's access scope depends on auth_type:
    1. With auth_type='user':
       - Access authenticated user's content
       - Includes their personal files and team content they can access
       - Namespace determined by root parameter
    
    2. With auth_type='team':
       - Access content as a specific team member
       - Requires team admin authentication
       - Can switch between team member contexts
       - Namespace determined by root parameter
    
    Root namespace types:
    - 'home': User's personal folder (default)
    - 'root': Team space (for accounts on teams)
    
    Note: While all accounts have both namespace values, the team space ('root')
    is only meaningful for accounts that are part of a team.
    
    For more details on namespaces:
    https://developers.dropbox.com/dbx-team-files-guide#namespaces
    
    Args:
        auth_type: 
            - 'user': Account access (on any plan)
            - 'team': Entire team access
        root: 'home' or 'root' namespace selection
        member_id: (Optional) The specific member ID to use for team requests.
                   If not provided, the client will be scoped to the authenticating admin.
        
    Returns:
        tuple: (Dropbox client, list of team members if team auth)
    """
    access_token = session.get('dropbox_access_token')
    if not access_token:
        return None

    # Configure client with OAuth 2 tokens and app credentials
    client_kwargs = {
        'oauth2_access_token': access_token,
        'app_key': DROPBOX_APP_KEY,
        'app_secret': DROPBOX_APP_SECRET
    }
    
    # Add refresh token for offline access if available
    if 'dropbox_refresh_token' in session:
        client_kwargs['oauth2_refresh_token'] = session['dropbox_refresh_token']

    # Create appropriate client type based on auth_type
    if auth_type == 'team':
        # Team authentication - allows acting as different team members
        dbx_team = dropbox.DropboxTeam(**client_kwargs) 
        
        # Use the passed-in member_id if available, otherwise default to the admin.
        if member_id:
            effective_member_id = member_id
        else:
            effective_member_id = get_admin_member_id(dbx_team)

        dbx = dbx_team.as_user(effective_member_id)
        team_members = get_team_members(dbx_team)
    else:
        # Personal account authentication
        dbx = dropbox.Dropbox(**client_kwargs)
        team_members = None

    # Configure root namespace for team folders if needed
    if root == 'root':
        # Get account info to access namespace IDs
        account_info = dbx.users_get_current_account()
        # Get team space namespace ID
        root_namespace_id = account_info.root_info.root_namespace_id
        # Create path root object for team space
        path_root = dropbox.common.PathRoot.root(root_namespace_id)
        # Configure client to use team space for all operations
        dbx = dbx.with_path_root(path_root)
    return dbx, team_members

@handle_dropbox_errors
def get_folder_contents(dbx_client, path=""):
    """
    List contents of a Dropbox folder with metadata.
    
    Uses files_list_folder API:
    https://www.dropbox.com/developers/documentation/http/documentation#files-list_folder
    
    Returns entries of type:
    - dropbox.files.FileMetadata: For files
    - dropbox.files.FolderMetadata: For folders
    
    Entries contain metadata like:
    - name: File/folder name
    - path_display: Full path
    - size: File size (for files)
    - server_modified: Last modified time (for files)
    
    Args:
        dbx_client: Authenticated Dropbox client
        path: Folder path to list (empty for root)
        
    Returns:
        list: Sorted entries (folders first, then files)
    """
    entries = []
    result = dbx_client.files_list_folder(
        path if path else '',
    )
    entries.extend(result.entries)
    
    # Handle pagination for folders with many items
    while result.has_more:
        result = dbx_client.files_list_folder_continue(result.cursor)
        entries.extend(result.entries)
    
    # Sort entries: folders first, then files alphabetically
    entries.sort(key=lambda x: (not isinstance(x, dropbox.files.FolderMetadata), x.name.lower()))
    return entries

# Route handlers
@app.route('/')
def index():
    """Landing page route."""
    return render_template('index.html')

@app.route('/login/<auth_type>')
def login(auth_type):
    """
    Start OAuth 2 authentication flow with Dropbox.
    
    The flow consists of:
    1. Redirect user to Dropbox authorization page
    2. User approves access
    3. Dropbox redirects back to DROPBOX_REDIRECT_URI
    4. oauth_callback handler exchanges code for tokens
    
    Args:
        auth_type: 'user' for personal account, 'team' for entire team access
    """
    if auth_type not in ['user', 'team']:
        return redirect(url_for('index'))
    # Check if offline access was requested via checkbox
    offline = request.args.get('offline') == 'true'
    session['auth_type'] = auth_type
    # Default to 'online' unless offline access was explicitly requested
    session['token_access_type'] = 'offline' if offline else 'online'
    flow = get_auth_flow(session['token_access_type'], auth_type)
    return redirect(flow.start())

@app.route('/oauth/callback')
@handle_dropbox_errors
def oauth_callback():
    """
    Handle OAuth 2 callback from Dropbox.
    
    Exchanges authorization code for:
    - access_token: Short-lived token for API calls
    - refresh_token: Long-lived token to get new access tokens
    """
    auth_type = session.get('auth_type', 'user')
    auth_flow = get_auth_flow(session.get('token_access_type', 'online'), auth_type)
    result = auth_flow.finish(request.args)
    session['dropbox_access_token'] = result.access_token
    if result.refresh_token:
        session['dropbox_refresh_token'] = result.refresh_token
    return redirect(url_for('browse', auth_type=auth_type))

@app.route('/browse/<auth_type>')
@handle_dropbox_errors
def browse(auth_type):
    """
    Display Dropbox folder contents.
    Args:
        auth_type: 'user' for personal account, 'team' for entire team access
    """
    if 'dropbox_access_token' not in session:
        return redirect(url_for('login', auth_type=auth_type))

    root = request.args.get('root', 'home')
    path = request.args.get('folder_path', '')
    member_id = request.args.get('member_id')
    
    dbx, team_members = get_dropbox_client(auth_type, root=root, member_id=member_id)
    if not dbx:
        return redirect(url_for('login', auth_type=auth_type))

    entries = get_folder_contents(dbx, path)
    parent_path = ''
    if path:
        path_parts = path.split('/')
        parent_path = '/'.join(path_parts[:-1]) if len(path_parts) > 1 else ''
    account_info = dbx.users_get_current_account()
    
    # Check if team space access should be disabled if it's a single user account
    disable_team_space = account_info.root_info.root_namespace_id == account_info.root_info.home_namespace_id
    
    # In team mode, the selected_member_id is the one we are acting as.
    selected_member_id = account_info.team_member_id if auth_type == 'team' else None

    return render_template(
        'file_browser.html',
        auth_type=auth_type,
        account=account_info,
        team_info=account_info.team if auth_type == 'team' else None,
        team_members=team_members,
        selected_member_id=selected_member_id,
        entries=entries,
        current_path=path,
        parent_path=parent_path,
        root=root,
        dropbox=dropbox,
        disable_team_space=disable_team_space
    )

@app.route('/logout')
def logout():
    """Clear session data and tokens."""
    session.clear()
    return redirect(url_for('index'))

@app.route('/download')
@handle_dropbox_errors
def download():
    """
    Download a file from Dropbox.
    
    Uses files_download API:
    https://www.dropbox.com/developers/documentation/http/documentation#files-download
    
    Returns file as attachment with original filename.
    """
    if 'dropbox_access_token' not in session:
        return redirect(url_for('index'))

    path = request.args.get('path')
    if not path:
        return "No file path specified", 400

    auth_type = request.args.get('auth_type', 'user')
    root = request.args.get('root', 'home')
    member_id = request.args.get('member_id')

    dbx, _ = get_dropbox_client(
        auth_type=auth_type,
        root=root,
        member_id=member_id
    )
    if not dbx:
        return redirect(url_for('login', auth_type=auth_type))

    # Download file and metadata in one call
    metadata, response = dbx.files_download(path)
    # Create a file-like object from the response content
    file_obj = io.BytesIO(response.content)
    
    return send_file(
        file_obj,
        download_name=metadata.name,
        as_attachment=True,
        mimetype='application/octet-stream'
    )

@app.route('/upload/<auth_type>', methods=['POST'])
@handle_dropbox_errors
def upload(auth_type):
    """
    Upload a file to Dropbox.
    
    Supports two upload methods:
    1. Simple upload for files (Do not use this to upload a file larger than 150 MiB)
       Uses files_upload API:
       https://www.dropbox.com/developers/documentation/http/documentation#files-upload
    
    2. Chunked upload for files > 150 MiB
       Uses upload session APIs:
       - files_upload_session_start
       - files_upload_session_append_v2
       - files_upload_session_finish
       
    Args:
        auth_type: 'user' for personal account, 'team' for entire team access
    """
    if 'dropbox_access_token' not in session:
        return redirect(url_for('index'))

    if 'file' not in request.files:
        return "No file part", 400
    file = request.files['file']
    if file.filename == '':
        return "No selected file", 400

    folder_path = request.form.get('folder_path', '')
    root = request.form.get('root', 'home')
    member_id = request.form.get('member_id')
    
    dbx, _ = get_dropbox_client(auth_type, root=root, member_id=member_id)
    if not dbx:
        return redirect(url_for('login', auth_type=auth_type))

    target_path = posixpath.join('/', folder_path, file.filename)

    # Get file size to determine upload method
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)

    # It is recommended to keep the chunk size as a multiple of 4 MB (4 * 1024 * 1024 bytes) when uploading large files using the Dropbox APIs
    CHUNK_SIZE = 64 * 1024 * 1024 

    # Simple upload for small files
    if file_size <= CHUNK_SIZE:
        metadata = dbx.files_upload(
            f=file.read(),
            path=target_path
        )
    else:
        # Chunked upload for large files
        session_start = dbx.files_upload_session_start(
            f=file.read(CHUNK_SIZE)
        )
        cursor = dropbox.files.UploadSessionCursor(
            session_id=session_start.session_id,
            offset=file.tell()
        )

        while file.tell() < file_size:
            if (file_size - file.tell()) <= CHUNK_SIZE:
                # Upload final chunk and complete the session
                metadata = dbx.files_upload_session_finish(
                    f=file.read(CHUNK_SIZE),
                    cursor=cursor,
                    commit=dropbox.files.CommitInfo(
                        path=target_path
                    )
                )
            else:
                # Upload intermediate chunks
                dbx.files_upload_session_append_v2(
                    f=file.read(CHUNK_SIZE),
                    cursor=cursor
                )
                cursor.offset = file.tell()

    return redirect(url_for('browse', 
                          auth_type=auth_type,
                          member_id=request.form.get('member_id'),
                          folder_path=request.form.get('folder_path'),
                          root=request.form.get('root'),
                          upload_success='true',
                          uploaded_file=metadata.name
                          ))

@handle_dropbox_errors
def get_shared_link_settings(shared_link):
    """
    Extract settings from an existing shared link to show in the UI
    """
    settings = {}
    
    # Check link permissions
    if shared_link.link_permissions:
        settings['allow_download'] = shared_link.link_permissions.allow_download
        
        # Check if password is required
        if shared_link.link_permissions.require_password:
            settings['require_password'] = True
        
        # Get the audience type (who can access the link)
        if shared_link.link_permissions.effective_audience:
            audience = shared_link.link_permissions.effective_audience
            if audience.is_team():
                settings['audience'] = 'team'
            elif audience.is_public():
                settings['audience'] = 'public'
            elif audience.is_no_one():
                settings['audience'] = 'no_one'
            elif audience.is_password():
                settings['audience'] = 'password'
            elif audience.is_members():
                settings['audience'] = 'members'
            elif audience.is_other():
                settings['audience'] = 'other'
    
    # Check expiration
    if shared_link.expires:
        settings['expires'] = 'custom'
        settings['expiration_timestamp'] = shared_link.expires.strftime('%Y-%m-%d')
    
    return settings

@handle_dropbox_errors
def create_link_settings(settings):
    """
    Create a SharedLinkSettings object from user input to create/update a link
    """
    # Set basic permissions like download access
    link_settings = dropbox.sharing.SharedLinkSettings(
        allow_download=settings.get('allow_download', True)
    )
    
    # Configure password protection if requested
    if settings.get('require_password') and settings.get('link_password'):
        link_settings.require_password = True
        link_settings.link_password = settings['link_password']
    else:
        link_settings.require_password = False
    
    # Set who can access the link
    if settings['audience'] == 'team':
        link_settings.audience = dropbox.sharing.LinkAudience.team
    elif settings['audience'] == 'no_one':
        link_settings.audience = dropbox.sharing.LinkAudience.no_one
    else:
        link_settings.audience = dropbox.sharing.LinkAudience.public

    remove_expiration = False
    # Handle link expiration settings
    if settings['expires'] != 'never':
        if settings['expires'] == 'custom' and settings.get('expiration_timestamp'):
            # Convert user-provided date to UTC timestamp
            expires_date = datetime.strptime(settings['expiration_timestamp'], '%Y-%m-%d')
            expires_date = expires_date.replace(tzinfo=timezone.utc)
            
            # Ensure the date is in the future
            if expires_date <= datetime.now(timezone.utc):
                raise ValueError('Expiration date must be in the future')
        else:
            # Convert days to timestamp
            days = int(settings['expires'])
            expires_date = datetime.now(timezone.utc) + timedelta(days=days)
        
        # Set the expiration timestamp
        link_settings.expires = expires_date
    else:
        # Mark that we should remove any existing expiration
        remove_expiration = True
        
    return link_settings, remove_expiration

@handle_dropbox_errors
def handle_get_shared_link(dbx, path):
    """
    Get information about an existing shared link.
    Only returns links that have viewer-only access.
    """
    shared_links = dbx.sharing_list_shared_links(path=path, direct_only=True).links
    # Filter for links that have viewer access level
    viewer_links = [link for link in shared_links 
                   if link.link_permissions.link_access_level.is_viewer()]
    
    if viewer_links:
        shared_link = viewer_links[0]  # Get the first viewer-only link
        settings = get_shared_link_settings(shared_link)
        
        return {
            'success': True,
            'url': shared_link.url,
            'settings': settings
        }
    
    return {
        'success': False,
        'message': 'No viewer-only shared link exists'
    }

@handle_dropbox_errors
def handle_create_shared_link(dbx, path, settings):
    """Create a new shared link with the specified settings."""
    link_settings, _ = create_link_settings(settings)

    try:
        shared_link = dbx.sharing_create_shared_link_with_settings(
            path=path,
            settings=link_settings
        )
        return {
            'success': True,
            'url': shared_link.url
        }
    except dropbox.exceptions.ApiError as e:
        if e.error.is_shared_link_already_exists():
            # Another process created a link while we were trying to create one
            # Return the existing link info so the client can decide what to do
            return {
                'success': False,
                'error': 'A shared link already exists',
                'error_type': 'link_exists'
            }
        raise

@handle_dropbox_errors
def handle_update_shared_link(dbx, settings):
    """Update an existing shared link with new settings."""
    if not settings.get('url'):
        return {
            'success': False,
            'error': 'URL is required to update shared link settings'
        }

    link_settings, remove_expiration = create_link_settings(settings)

    try:
        shared_link = dbx.sharing_modify_shared_link_settings(
            url=settings['url'],
            settings=link_settings,
            remove_expiration=remove_expiration
        )
        return {
            'success': True,
            'url': shared_link.url
        }
    except dropbox.exceptions.ApiError as e:
        if e.error.is_shared_link_not_found():
            # The link was revoked or doesn't exist anymore
            return {
                'success': False,
                'error': 'The shared link no longer exists',
                'error_type': 'link_not_found'
            }
        raise

@handle_dropbox_errors
def handle_delete_shared_link(dbx):
    """
    Revoke (delete) an existing shared link.
    """
    url = request.args.get('url')
    
    if not url:
        return {
            'success': False,
            'error': 'URL parameter is required to revoke a shared link'
        }, 400

    dbx.sharing_revoke_shared_link(url=url)
    return {
        'success': True,
        'message': 'Shared link revoked successfully'
    }

@app.route('/share', methods=['GET', 'POST', 'DELETE'])
@handle_dropbox_errors
def share():
    """
    Handle all shared link operations:
    GET: Get existing shared link and its settings
    POST: Create new shared link or update existing one
    DELETE: Revoke (delete) existing shared link
    """
    if 'dropbox_access_token' not in session:
        return redirect(url_for('index'))

    path = None
    # Path is required for GET and POST, but not for DELETE (which uses URL)
    if request.method != 'DELETE':
        path = request.args.get('path') if request.method == 'GET' else request.json.get('path')
        if not path:
            return {"success": False, "error": "No file or folder path specified"}, 400
        if not path.startswith('/'):
            path = '/' + path
    # Get parameters from the request based on method
    if request.method in ['GET', 'DELETE']:
        root = request.args.get('root', 'home')
        member_id = request.args.get('member_id')
        auth_type = request.args.get('auth_type', 'user')
    else:  # POST
        root = request.json.get('root', 'home')
        member_id = request.json.get('member_id')
        auth_type = request.json.get('auth_type', 'user')
    
    dbx, _ = get_dropbox_client(
        auth_type=auth_type,
        root=root,
        member_id=member_id
    )
    if not dbx:
        return redirect(url_for('login', auth_type=auth_type))
    
    if request.method == 'DELETE':
        return handle_delete_shared_link(dbx)
    elif request.method == 'GET':
        return handle_get_shared_link(dbx, path)
    else:  # POST method
        # If URL is provided, attempt to update existing link
        if request.json.get('url'):
            result = handle_update_shared_link(dbx, request.json)
            if result['success'] or result.get('error_type') != 'link_not_found':
                result['SuccessMessage'] = 'Shared link updated successfully'
                return result
            # If link not found, fall through to create new link
        result = handle_create_shared_link(dbx, path, request.json)
        result['SuccessMessage'] = 'Shared link created successfully'
        # Create new link if no URL provided or previous link was not found
        return result

# Run the Flask application in debug mode if executed directly
if __name__ == '__main__':
    app.run(debug=True)
