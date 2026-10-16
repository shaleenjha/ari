import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setData } from './data/client';
import { MockData } from './data/mock';
import './ui/styles.css';

setData(new MockData()); // synthetic only until the app2 backend exists
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
