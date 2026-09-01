/* eslint-disable */
import ReactDOM from 'react-dom/client';
import '../index.css';
import { TicketPage } from '../components/TicketPage';
import { EpicPage } from '../components/EpicPage';
import { task, epicTask } from './fixtures';

const params = new URLSearchParams(window.location.search);
const which = params.get('story');
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

function Story() {
  if (which === 'epic') {
    return (
      <div style={{ height: '100vh', background: 'var(--hm-canvas)' }}>
        <EpicPage task={epicTask as any} onClose={() => {}} onOpenTask={() => {}} />
      </div>
    );
  }
  return (
    <div style={{ height: '100vh', background: 'var(--hm-canvas)' }}>
      <TicketPage
        task={task as any}
        onEdit={() => {}}
        onChanged={() => {}}
        onClose={() => {}}
        onOpenTask={() => {}}
      />
    </div>
  );
}

document.documentElement.setAttribute('data-theme', theme);
ReactDOM.createRoot(document.getElementById('root')!).render(<Story />);
