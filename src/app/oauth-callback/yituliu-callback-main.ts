import { completeYituliuCallback, readYituliuSession } from '@/shared/storage/yituliu-session';
import './oauth-callback.scss';

const status = document.querySelector<HTMLElement>('#oauth-status');
const state = new URL(location.href).searchParams.get('state');
document.querySelector('#oauth-close')?.addEventListener('click', () => window.close());

void completeYituliuCallback().then(() => {
  if (status !== null) status.textContent = state !== null && readYituliuSession()?.id === state
    ? '登录成功，请返回原页面。'
    : '登录回调无效，请返回原页面重试。';
}).catch(() => {
  if (status !== null) { status.textContent = '登录失败，请返回原页面重试。'; status.setAttribute('role', 'alert'); }
});
