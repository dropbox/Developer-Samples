# Dropbox File Browser

A web-based file browser application built with Flask and the Dropbox Python SDK. This application demonstrates the usage of Dropbox API for both individual users and team accounts.

## Features

### Core Features
- Browse and navigate through Dropbox folders
- Download files directly from Dropbox
- Upload a file with support for large file sizes (chunked upload)
- Create and manage shared links for files and folders
- Customize sharing settings including:
  - Access level (public/team/no additional access)
  - Password protection
  - Link expiration
  - Download permissions
- File size and modification date display
- Breadcrumb navigation for easy folder traversal
- Toggle between personal and team spaces
- Switch between team members' accounts (team admin only)

### Technical Features
- OAuth 2 authentication with Dropbox API
- Support for both short-term and long-term access
- Efficient file metadata handling
- Proper path root management for team spaces
- Error handling and session management
- Responsive web interface

## Project Structure

```
file_browser/
├── app.py                 # Main Flask application and Dropbox API integration
├── requirements.txt       # Python dependencies
├── .env                  # Environment variables (create this file)
├── templates/            # HTML templates
│   ├── index.html       # Landing page with OAuth login options
│   └── file_browser.html # Main file browser interface
└── .gitignore           # Git ignore rules
```

### Key Components:
- `app.py`: Contains all the route handlers and Dropbox API integration logic
  - OAuth 2 authentication flow
  - File/folder browsing logic
  - Team space management
  - Download functionality
  - File upload functionality
  - Shared link creation and management
  - Team data transport API call limit handling
- `templates/`: HTML templates with a clean, responsive design
  - `index.html`: Simple landing page with user/team login options
  - `file_browser.html`: Main interface with file browsing and team management
- `requirements.txt`: Lists required Python packages:
  - Flask for web framework
  - Dropbox SDK for API integration
  - python-dotenv for environment management

## Setup

### 1. Dropbox API Configuration

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click "Create app"
3. Choose the following settings:
   - Choose an API: "Scoped access"
   - Choose the type of access: "Full Dropbox"
   - Name your app: Choose a unique name

4. Configure your new Dropbox app:
   - In the Settings tab:
     - Note your "App key" and "App secret"
     - Add `http://localhost:5000/oauth/callback` to "Redirect URIs"
     
   
   - In the Permissions tab, enable these permissions:
     ```
     account_info.read  (For accessing user account information)
     files.metadata.read (For listing files and folders)
     files.content.read (For downloading files)
     files.content.write (For uploading files)
     sharing.write (For creating and modifying shared links)
     sharing.read (For reading shared link metadata)
     
     # Additional scopes for team features:
     team_info.read (For accessing team information)
     team_data.member (For switching between team members)
     members.read (For listing team members)
     ```

> **Important Note**: The user scopes provide access to both individual and team space content. If you're a member of a Dropbox team, you can access your team's shared files and folders with just the basic scopes (`account_info.read`, `files.metadata.read`, and `files.content.read`). The additional team scopes are only needed for admin tasks like switching between team members' accounts.

### 2. Local Environment Setup

1. Clone the repository and create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Unix/macOS
   # OR
   .\venv\Scripts\activate   # On Windows
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up environment variables using one of these methods:

   Option A: Using a .env file (recommended for development)
   ```bash
   # Create a .env file in the project root:
   DROPBOX_APP_KEY=your_app_key_from_dropbox_console
   DROPBOX_APP_SECRET=your_app_secret_from_dropbox_console
   DROPBOX_REDIRECT_URI=http://localhost:5000/oauth/callback
   ```

   Option B: Setting environment variables directly
   ```bash
   # Unix/macOS:
   export DROPBOX_APP_KEY=your_app_key_from_dropbox_console
   export DROPBOX_APP_SECRET=your_app_secret_from_dropbox_console
   export DROPBOX_REDIRECT_URI=http://localhost:5000/oauth/callback

   # Windows Command Prompt:
   set DROPBOX_APP_KEY=your_app_key_from_dropbox_console
   set DROPBOX_APP_SECRET=your_app_secret_from_dropbox_console
   set DROPBOX_REDIRECT_URI=http://localhost:5000/oauth/callback

   # Windows PowerShell:
   $env:DROPBOX_APP_KEY="your_app_key_from_dropbox_console"
   $env:DROPBOX_APP_SECRET="your_app_secret_from_dropbox_console"
   $env:DROPBOX_REDIRECT_URI="http://localhost:5000/oauth/callback"
   ```

4. Run the application:
   ```bash
   python app.py
   ```

The application will be available at `http://localhost:5000`

### 3. Usage Notes

- For personal use:
  - Log in with your Dropbox account
  - The app will request the necessary permissions
  - You can access your personal and team files and folders

- For team features:
  - You need admin access to a Dropbox Business team
  - Log in with your team admin account
  - You can switch between team members

- Access Token Options:
  - Short-term access (default): Uses short-lived access tokens; re-authenticate required periodically.
  - Long-term access: Uses short-lived access tokens with refresh tokens; re-authentication not required. Check "Request long-term access" on login.

### 4. Sharing Features

- Create shared links for any file or folder
- Configure sharing settings:
  - Audience Control:
    - Public access (anyone with the link)
    - Team-only access (only team members)
    - No additional access (link doesn't grant additional permissions beyond what users already have)
  - Security Options:
    - Password protection
    - Custom expiration dates
    - Download permissions
- Manage existing shared links:
  - View current settings
  - Update settings
  - Revoke access

> **Note**: In current implementation shared links are created with viewer-only access. This means recipients can view but not edit the shared content.

## Dependencies

- Flask
- Dropbox SDK
- python-dotenv
 
