/* eslint-disable */
import ReactDOM from 'react-dom/client';
import '../index.css';
import { TicketPage } from '../components/TicketPage';
import { EpicPage } from '../components/EpicPage';
import { Board } from '../components/Board';
import { task, boardEpic, boardTasks, doneEpic } from './fixtures';

const params = new URLSearchParams(window.location.search);
const which = params.get('story');
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

function Story() {
  if (which === 'board') {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', padding: 24 }}>
        <Board
          tasks={boardTasks}
          loading={false}
          epics={[boardEpic, doneEpic]}
          onOpen={() => {}}
          onOpenTask={() => {}}
          onChanged={() => {}}
          onNewTask={() => {}}
          onOpenEpic={() => {}}
        />
      </div>
    );
  }
  if (which === 'epic') {
    return (
      <div style={{ height: '100vh', background: 'var(--hm-canvas)' }}>
        <EpicPage epicRef={boardEpic.ref} workspaceId={1} onClose={() => {}} onOpenTask={() => {}} />
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
