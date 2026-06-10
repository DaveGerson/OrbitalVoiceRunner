import {StrictMode, Suspense, lazy, Component} from 'react';
import type {ErrorInfo, ReactNode, CSSProperties} from 'react';
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

// 1A.3 — no more white page. The kitchen is a lazy chunk: a post-deploy chunk 404 (stale
// index.html naming a rotated hash) or any render throw used to leave a PERMANENT blank page
// (Suspense fallback was null and nothing above it caught). This boundary catches both and
// renders a recovery card. Deliberately dependency-free (inline styles, no lucide/motion):
// index.css / the kitchen CSS may never have loaded if the chunk itself failed.
const fallbackStyles: Record<string, CSSProperties> = {
  shell: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#16130f',
    color: '#f3ece2',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    maxWidth: '26rem',
    padding: '2rem',
    borderRadius: '12px',
    border: '1px solid #3d352b',
    background: '#211c16',
    textAlign: 'center',
  },
  button: {
    marginTop: '1.25rem',
    padding: '0.5rem 1.5rem',
    borderRadius: '8px',
    border: '1px solid #6b5b41',
    background: '#3a3022',
    color: '#f3ece2',
    fontSize: '1rem',
    cursor: 'pointer',
  },
  link: {
    display: 'block',
    marginTop: '0.85rem',
    color: '#c9a96a',
    fontSize: '0.85rem',
  },
};

class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean}> {
  // Explicit field declarations — the same workaround src/App.tsx's ErrorBoundary uses for this
  // project's loose React typings (Component's generics don't surface props/state here).
  state: {hasError: boolean};
  props: {children: ReactNode};

  constructor(props: {children: ReactNode}) {
    super(props);
    this.props = props;
    this.state = {hasError: false};
  }
  static getDerivedStateFromError() {
    return {hasError: true};
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[main] kitchen render/chunk failure:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={fallbackStyles.shell}>
          <div style={fallbackStyles.card}>
            <h1 style={{margin: 0, fontSize: '1.3rem'}}>The kitchen hit a snag.</h1>
            <p style={{marginTop: '0.75rem', opacity: 0.8}}>
              Something failed while serving the interface — a reload usually clears it.
            </p>
            <button style={fallbackStyles.button} onClick={() => location.reload()}>
              Reload
            </button>
            <a style={fallbackStyles.link} href="?ui=classic">
              Or switch to the classic UI
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {useKitchen ? (
      <ErrorBoundary>
        <Suspense
          fallback={
            <div style={fallbackStyles.shell}>
              <div>Firing up the kitchen…</div>
            </div>
          }
        >
          <OrbitalApp />
        </Suspense>
      </ErrorBoundary>
    ) : (
      <App />
    )}
  </StrictMode>,
);
