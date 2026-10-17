import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setData } from './data/client';
import { MockData } from './data/mock';
import { RestData } from './data/rest';
import { JWT_A, MockPostgrest, WS_A } from './data/pgmock';
import './ui/styles.css';

// Synthetic only until an app2 backend exists: the typed REST layer over an in-memory PostgREST mock (?data=mock = legacy layer).
const legacy = new URLSearchParams(location.search).get('data') === 'mock';
setData(legacy ? new MockData() : new RestData(new MockPostgrest().fetch, '', WS_A, JWT_A));
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
