/**
 * main.jsx - Application Entry Point
 * This file serves as the main entry point for the React application.
 * It initializes the React root and renders the main App component.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Create and render the root React component
// StrictMode is enabled for additional development checks and warnings
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
