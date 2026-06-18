import React from 'react';
import ReactDOM from 'react-dom/client';
import { addCollection, setCustomIconsLoader } from '@iconify/react';
import solar from '@iconify-json/solar/icons.json';
import App from './App.jsx';
import './styles.css';

// Bundle the Solar icon set so icons render fully offline (no network/API call).
addCollection(solar);

// Hard-disable Iconify's online API: if an icon name is ever missing/mistyped,
// @iconify/react would otherwise fetch it from api.iconify.design (+ simplesvg /
// unisvg mirrors). A no-op loader for the only prefix we use makes a missing icon
// render nothing instead of phoning home — guaranteeing zero icon network calls.
setCustomIconsLoader(() => null, 'solar');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
