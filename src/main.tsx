import {StrictMode, Suspense, lazy} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// The Orbital Kitchen reskin is now the DEFAULT. The classic app remains a fallback,
// reachable via `?ui=classic` (or localStorage 'orbital-ui'='classic'). `?ui=kitchen`
// forces the kitchen. OrbitalApp is lazy-loaded so `?ui=classic` never imports the
// kitchen module tree (its CSS / webfonts), keeping the classic fallback lean.
const OrbitalApp = lazy(() => import('./orbital/OrbitalApp.tsx'));

const params = new URLSearchParams(location.search);
const uiParam = params.get('ui');
const useKitchen =
  uiParam === 'kitchen' ||
  (uiParam !== 'classic' && localStorage.getItem('orbital-ui') !== 'classic');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {useKitchen ? (
      <Suspense fallback={null}>
        <OrbitalApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
