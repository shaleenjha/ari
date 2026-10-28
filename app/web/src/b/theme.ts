// B+ theme: dark follows the system setting and also turns on from 18:00 to 06:00 local time. ?theme=dark|light pins it (QA).
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export function pickTheme(systemDark: boolean, hour: number, pinned: string | null): Theme {
  if (pinned === 'dark' || pinned === 'light') return pinned;
  return systemDark || hour >= 18 || hour < 6 ? 'dark' : 'light';
}

function apply(t: Theme) {
  const root = document.documentElement;
  root.dataset.theme = t;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', bg);
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => current());
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme(current());
    mq.addEventListener('change', update);
    const t = setInterval(update, 60_000);
    return () => { mq.removeEventListener('change', update); clearInterval(t); };
  }, []);
  useEffect(() => apply(theme), [theme]);
  return theme;
}

function current(): Theme {
  return pickTheme(matchMedia('(prefers-color-scheme: dark)').matches, new Date().getHours(), new URLSearchParams(location.search).get('theme'));
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
