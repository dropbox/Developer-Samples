# Dropbox File Browser

A client-side web application built with the Dropbox JavaScript SDK and React (using Vite) for browsing, viewing, and managing files in a Dropbox account. It demonstrates how to use the Dropbox API with OAuth 2.0, supporting both individual and team accounts.

## Features

### Core Features
- **Browse and Navigate**: Traverse through your Dropbox folders and files.
- **Download Files**: Download files directly from your Dropbox.
- **Upload Files**: Upload files to the current Dropbox folder.
- **Create Shared Links**: Create and manage shared links for your files and folders.
- **Team Support**: For Dropbox Business accounts, switch between team members to view their files. (Team admin only)
- **Namespace Toggle**: Switch between personal and team spaces when you're a member of a Dropbox team.
- **Breadcrumb Navigation**: Easily navigate the folder hierarchy.
- **File Details**: View file size and last modified date.
- **Real-time Updates**: Automatically sync file changes using long-polling.

### Technical Features
- **Secure Authentication**: Uses OAuth 2.0 with PKCE flow for secure client-side authentication.
- **Offline Access**: Optional long-term access via refresh tokens to stay logged in.
- **Team Space Management**: Properly handles path roots for accessing team spaces.
- **Responsive UI**: A clean interface that works on different screen sizes.

## Project Structure

```
file_browser/
├── .env                  # Environment variables (you need to create this)
├── .gitignore            # Git ignore rules
├── index.html            # Main HTML entry point
├── package.json          # Project dependencies and scripts
├── vite.config.js        # Vite configuration
└── src/
    ├── components/       # React components
    │   ├── FileBrowser.jsx
    │   ├── LoginPage.jsx
    │   └── ...
    ├── contexts/         # React contexts
    │   └── AuthContext.jsx
    ├── utils/            # Utility functions
    │   └── dropboxClient.js
    ├── App.jsx           # Main application component
    └── main.jsx          # Application entry point
```

## Setup

### 1. Dropbox API Configuration

1.  Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) and click "Create app".
2.  Choose the following settings:
    *   **API**: "Scoped access"
    *   **Access type**: "Full Dropbox"
    *   **Name**: Choose a unique name for your app.

3.  Configure your new Dropbox app:
    *   In the **Settings** tab:
        *   Note your "App key". This will be your `VITE_DROPBOX_APP_KEY`.
        *   Add `http://localhost:5173/oauth-callback` to "Redirect URIs".
    *   In the **Permissions** tab, enable these scopes:
        *   `account_info.read` (For accessing user account information)
        *   `files.metadata.read` (For listing files and folders)
        *   `files.content.read` (For downloading files)
        *   `files.content.write` (For uploading files)
        *   `sharing.read` (For reading shared link metadata)
        *   `sharing.write` (For creating and modifying shared links)
        *   **For Team features, also add:**
        *   `members.read` (For listing team members)
        *   `team_data.member` (For switching between team members)
        *   `team_info.read` (For accessing team information)

### 2. Local Environment Setup

1.  Clone the repository and navigate to the project directory:
    ```sh
    git clone <repository-url>
    cd JavaScript/file_browser
    ```

2.  Install dependencies:
    ```sh
    npm install
    ```

3.  Set up environment variables by creating a `.env` file in the `file_browser` directory:
    ```env
    VITE_DROPBOX_APP_KEY="YOUR_APP_KEY_FROM_DROPBOX_CONSOLE"
    VITE_DROPBOX_REDIRECT_URI="http://localhost:5173/oauth-callback"
    ```
    Replace `YOUR_APP_KEY_FROM_DROPBOX_CONSOLE` with your actual Dropbox App key.

4.  Run the application:
    ```sh
    npm run dev
    ```
    The application will be available at `http://localhost:5173`.

## Usage Notes

### For personal use:
- Log in with your Dropbox account
- The app will request the necessary permissions
- You can access your personal and team files and folders

### For team features:
- You need admin access to a Dropbox Business team
- Log in with your team admin account
- You can switch between team members

### Access Token Options:
- **Short-term access (default)**: Uses short-lived access tokens; re-authentication required periodically.
- **Long-term access**: Uses short-lived access tokens with refresh tokens; re-authentication not required. Check "Request long-term access" on login.

## Sharing Features

### Create shared links for any file or folder
### Configure sharing settings:
#### Audience Control:
- Public access (anyone with the link)
- Team-only access (only team members)
- No additional access (link doesn't grant additional permissions beyond what users already have)

#### Security Options:
- Password protection
- Custom expiration dates
- Download permissions

### Manage existing shared links:
- View current settings
- Update settings
- Revoke access

**Note**: In current implementation shared links are created with viewer-only access. This means recipients can view but not edit the shared content. 

## Prerequisites

**Node version: 22.12 or above**: Please make sure you have Node version 22.12 or above in order to avoid the error `TypeError: crypto.hash is not a function.`

## Dependencies

This project relies on the following key packages:
- **React**: A JavaScript library for building user interfaces.
- **React Router**: For client-side routing.
- **Dropbox SDK**: For interacting with the Dropbox API.
- **Vite**: As the frontend build tool and development server. 
