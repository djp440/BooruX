import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { readCachedTheme } from './rating-settings';
import './style.css';

const cachedTheme = readCachedTheme();
if (cachedTheme !== 'system') document.documentElement.dataset.theme = cachedTheme;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
