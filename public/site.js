/* Shared site chrome: current-page nav highlight, per-code-block copy buttons, and a
   "Copy for AI" button that yields clean Markdown of the page for pasting into an assistant. */
(() => {
  'use strict';
  const path = location.pathname.replace(/\/+$/, '') || '/';

  /* --- mark the current nav item --- */
  document.querySelectorAll('.primary-nav a').forEach((a) => {
    const href = a.getAttribute('href');
    const norm = href.replace(/\/+$/, '') || '/';
    if (norm === path) { a.setAttribute('aria-current', 'page'); a.classList.add('current'); }
  });

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1400); }
  }

  /* --- copy button on every <pre> --- */
  document.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.no-copy')) return;
    const wrap = document.createElement('div');
    wrap.className = 'codewrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'copybtn'; btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.onclick = () => copy(pre.innerText, btn);
    wrap.appendChild(btn);
  });

  /* --- page -> Markdown (for pasting into an AI) --- */
  function pageMarkdown() {
    const root = document.querySelector('article') || document.querySelector('.wrap') || document.body;
    const out = [];
    const walk = (node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) return;
        if (n.nodeType !== 1) return;
        const el = n;
        if (el.closest('header.top') || el.tagName === 'HEADER' || el.tagName === 'FOOTER' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.classList.contains('copybtn') || el.classList.contains('toc')) return;
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) { out.push('\n' + '#'.repeat(+tag[1]) + ' ' + el.textContent.trim() + '\n'); return; }
        if (tag === 'pre') { out.push('\n```\n' + el.innerText.replace(/\n+$/, '') + '\n```\n'); return; }
        if (tag === 'ul' || tag === 'ol') { el.querySelectorAll(':scope > li').forEach((li) => out.push('- ' + li.innerText.trim().replace(/\s*\n\s*/g, ' '))); out.push(''); return; }
        if (tag === 'table') { out.push('\n' + tableToMd(el) + '\n'); return; }
        if (tag === 'p') { const t = el.innerText.trim(); if (t) out.push(t + '\n'); return; }
        if (['div', 'section', 'dl', 'details', 'main'].includes(tag)) { walk(el); return; }
        if (tag === 'dt') { out.push('**' + el.textContent.trim() + '**'); return; }
        if (tag === 'dd') { out.push(el.textContent.trim() + '\n'); return; }
        const t = el.innerText && el.innerText.trim();
        if (t) out.push(t + '\n');
      });
    };
    const tableToMd = (table) => {
      const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.innerText.trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')));
      if (!rows.length) return '';
      const head = rows[0];
      const md = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
      rows.slice(1).forEach((r) => md.push('| ' + r.join(' | ') + ' |'));
      return md.join('\n');
    };
    walk(root);
    const title = (document.querySelector('h1')?.textContent || document.title).trim();
    return `# ${title}\n\nSource: ${location.href}\n` + out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* --- "Copy for AI" button in the header --- */
  const nav = document.querySelector('header.top nav.primary-nav') || document.querySelector('header.top nav');
  if (nav) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ai-copy'; btn.textContent = 'Copy for AI';
    btn.title = 'Copy this page as Markdown to paste into an AI assistant';
    btn.onclick = () => copy(pageMarkdown(), btn);
    nav.appendChild(btn);
  }
})();
