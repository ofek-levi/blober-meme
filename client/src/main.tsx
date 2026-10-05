import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GameProvider } from './game';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// Deliberately no StrictMode: its double-invoked effects fire duplicate socket joins in dev.
createRoot(container).render(
  <GameProvider>
    <App />
  </GameProvider>
);
