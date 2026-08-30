import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import './index.css';

// WORK-074: wrap the App in the canonical AuthProvider so the auth-state
// source is the ONE place every consumer reads from. A successful sign-in
// updates this state synchronously → the App shell re-renders → protected
// routes become visible WITHOUT a manual reload (proof #15).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
