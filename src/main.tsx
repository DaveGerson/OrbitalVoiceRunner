import {StrictMode, Suspense, lazy} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Migration flag: the Orbital Kitchen reskin is built wave-by-wave behind
// `?ui=kitchen` (or localStorage 'orbital-ui'='kitchen') so the classic app —
// and its e2e suite — stay green until the reskin is complete, at which point
// the default flips. `?ui=classic` forces the old app.
//
// OrbitalApp is lazy-loaded so the classic path never imports the kitchen
// module tree (its CSS / webfonts), keeping the classic app byte-identical.
const OrbitalApp = lazy(() => import('./orbital/OrbitalApp.tsx'));

const params = new URLSearchParams(location.search);
const uiParam = params.get('ui');
const useKitchen =
  uiParam === 'kitchen' ||
  (uiParam !== 'classic' && localStorage.getItem('orbital-ui') === 'kitchen');

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
