import '@fontsource/cormorant-garamond/300.css';
import '@fontsource/cormorant-garamond/300-italic.css';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';

const container = document.getElementById('app')!;

function fail(message: string): void {
  container.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = message;
  container.append(p);
}

try {
  const app = new App(container);
  (window as unknown as { echoes: App }).echoes = app;
  if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
} catch (err) {
  console.error(err);
  fail('ECHOES needs WebGL. Please open it in a recent desktop Chrome, Edge or Firefox with hardware acceleration enabled.');
}
