/* eslint-disable */
import ReactDOM from 'react-dom/client';
import '../index.css';
import { TicketPage } from '../components/TicketPage';
import { task } from './fixtures';

function Story() {
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

document.documentElement.setAttribute('data-theme', 'dark');
ReactDOM.createRoot(document.getElementById('root')!).render(<Story />);
