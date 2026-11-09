// A Copy button on each code block. Without JavaScript the blocks read and select as usual.
const status = Object.assign(document.createElement('p'), { className: 'visually-hidden' });
status.setAttribute('role', 'status');
document.body.append(status);

for (const pre of document.querySelectorAll('pre')) {
  if (pre.closest('#demo')) continue;
  const wrap = Object.assign(document.createElement('div'), { className: 'code' });
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'copy', textContent: 'Copy' });
  pre.replaceWith(wrap);
  wrap.append(pre, button);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      button.textContent = status.textContent = 'Copied';
    } catch {
      button.textContent = status.textContent = 'Couldn’t copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; status.textContent = ''; }, 2000);
  });
}
