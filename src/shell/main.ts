import { mountInspector } from './inspector';
import { mountLauncher } from './launcher';
import { mountTitlebar } from './titlebar';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');

const view = new URLSearchParams(location.search).get('view');
if (view === 'inspector') {
    document.title = 'Deskapp Inspector';
    mountInspector(root);
} else if (view === 'titlebar') {
    mountTitlebar(root);
} else {
    mountLauncher(root);
}
