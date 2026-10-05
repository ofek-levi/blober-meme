import type { ReactElement } from 'react';
import { useGame } from './game';
import { Editor } from './screens/Editor';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Results } from './screens/Results';
import { Vote } from './screens/Vote';

export function App(): ReactElement {
  const { connected } = useGame();
  return (
    <div className="app">
      {!connected && <div className="notice">Reconnecting…</div>}
      <CurrentScreen />
    </div>
  );
}

function CurrentScreen(): ReactElement {
  const { state } = useGame();
  if (state === null) return <Home />;
  if (state.phase === 'create') return <Editor />;
  if (state.phase === 'vote') return <Vote />;
  if (state.phase === 'results') return <Results />;
  return <Lobby />;
}
