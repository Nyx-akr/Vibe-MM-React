import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AdminPanel from './admin/AdminPanel.jsx';

// Two entry points, no router dependency: /admin renders the admin panel,
// everything else renders the dashboard.
const isAdmin = window.location.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/admin');

createRoot(document.getElementById('root')).render(isAdmin ? <AdminPanel /> : <App />);
