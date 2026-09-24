import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function App() {
  return <div className="p-8 text-slate-800">Roomly</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
