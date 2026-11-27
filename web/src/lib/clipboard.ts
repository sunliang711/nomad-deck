import { trText } from './locale.ts';

// Clipboard API may fail or be unavailable on plain HTTP LAN pages; fallback to execCommand copy.
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to legacy copy path.
  }

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position: fixed; left: -9999px; top: 0; opacity: 0; pointer-events: none';
  document.body.appendChild(input);
  try {
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) {
      throw new Error(trText('当前浏览器环境不支持自动复制，请手动复制', 'Clipboard copy is not supported in this browser; please copy manually'));
    }
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
  }
}
