// B+ shell entry (b.html). Demo data only; no network calls, no sign-in wiring of its own.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './tokens.css';
import './b.css';
import './screens.css';

// Hold the first paint until Plus Jakarta Sans is ready (at most 1.5 s), so nothing reflows from the fallback font.
const ready = Promise.race([document.fonts.load('400 1rem "Plus Jakarta Sans"').catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
document.addEventListener('touchstart', () => undefined, { passive: true });
void ready.then(() => createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>));
