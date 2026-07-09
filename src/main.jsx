import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: intentionally NOT wrapped in <React.StrictMode>. StrictMode double-
// invokes effects in development, which would open the signaling WebSocket and
// peer connection twice. This app's connection is a long-lived singleton, so we
// mount it once.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
