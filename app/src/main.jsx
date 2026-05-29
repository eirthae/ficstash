import React from 'react';
import ReactDOM from 'react-dom/client';
import { addCollection } from '@iconify/react';
import solar from '@iconify-json/solar/icons.json';
import App from './App.jsx';
import './styles.css';

// Bundle the Solar icon set so icons render fully offline (no network/API call).
addCollection(solar);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
