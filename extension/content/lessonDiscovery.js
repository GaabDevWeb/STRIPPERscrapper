/**
 * Discovery de aulas — HTML Infnet (accordions + recording-item + transcription-link).
 * Compatível com páginas multi-disciplina (Java / C# / Projeto de Bloco, etc.).
 */
(function lessonDiscoveryContent() {
  function expandAllAccordions() {
    // Mostrar cards escondidos e disparar clique nos botões (alguns blocos só hidratam ao abrir)
    for (const card of document.querySelectorAll('.infnetci-card')) {
      try {
        card.style.display = '';
        card.style.visibility = 'visible';
      } catch {
        /* ignore */
      }
    }
    for (const btn of document.querySelectorAll('button.infnetci-accordion-button')) {
      try {
        const section = btn.closest('section.infnetci-accordion');
        const card = section?.querySelector('.infnetci-card');
        const hidden =
          card &&
          (card.style.display === 'none' ||
            getComputedStyle(card).display === 'none' ||
            card.hidden);
        if (hidden) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          if (typeof btn.click === 'function') btn.click();
        }
      } catch {
        /* ignore */
      }
    }
  }

  function findTranscriptionLink(el) {
    return (
      el.querySelector('a.transcription-link') ||
      el.querySelector('a.recording-link.transcription-link') ||
      el.querySelector('a[href*="drive.google.com"][href*="/file/d/"]') ||
      [...el.querySelectorAll('a.recording-link')].find((a) =>
        /transcri/i.test(a.textContent || a.getAttribute('aria-label') || '')
      ) ||
      null
    );
  }

  function extractLessonItemsFromPage() {
    const items = [...document.querySelectorAll('.infnetci-recording-item')];

    return items
      .map((el) => {
        const h3 = el.querySelector('h3');
        const a = findTranscriptionLink(el);
        const section = el.closest('section.infnetci-accordion');
        const accordionTitle =
          section?.querySelector('button.infnetci-accordion-button')?.textContent?.trim() || '';
        return {
          title: h3 ? h3.textContent.trim() : '',
          href: a ? a.href : '',
          accordionTitle,
        };
      })
      .filter((x) => x.href);
  }

  function resolveCourseTitle() {
    const accordionTexts = [...document.querySelectorAll('button.infnetci-accordion-button')]
      .map((b) => b.textContent.trim())
      .filter((t) => t.length > 1);
    if (accordionTexts.length) {
      const uniq = [...new Set(accordionTexts)];
      if (uniq.length === 1) return uniq[0];
      if (uniq.length <= 3) return uniq.join(' · ');
      return `Vários módulos (${uniq.length}) — ${uniq.slice(0, 2).join(' · ')}…`;
    }

    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim() || '';
    };
    const selectors = [
      'h1.entry-title',
      '.entry-header h1',
      '.bb-focus-header h1',
      '.group-header h1',
      '[class*="group-title"] h1',
      'article h1',
      'main h1',
      'h1',
      '.entry-title',
    ];
    for (const s of selectors) {
      const t = pick(s);
      if (t.length > 2 && t.length < 240) return t;
    }
    let title = (document.title || '').trim();
    title = title
      .replace(/\s*[|\-–—]\s*Instituto Infnet.*$/i, '')
      .replace(/\s*[|\-–—]\s*Infnet.*$/i, '')
      .trim();
    if (title.length > 2 && title.length < 240) return title;
    return 'Disciplina';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'EXTRACT_LESSONS') return false;
    const L = globalThis.__stripperLog;

    (async () => {
      try {
        if (location.href.includes('wp-login.php')) {
          L?.warn?.('lessons', 'EXTRACT_LESSONS on login page');
          sendResponse({
            ok: false,
            errorKind: 'session_expired',
            error: 'Login page — sessão não autenticada',
          });
          return;
        }

        expandAllAccordions();
        await new Promise((r) => setTimeout(r, 400));
        expandAllAccordions();
        await new Promise((r) => setTimeout(r, 200));

        const items = extractLessonItemsFromPage();
        const courseName = resolveCourseTitle();
        const accordionCount = document.querySelectorAll('button.infnetci-accordion-button').length;
        const itemCount = document.querySelectorAll('.infnetci-recording-item').length;
        const transcriptCount = document.querySelectorAll('a.transcription-link').length;

        L?.info?.('lessons', 'EXTRACT_LESSONS', {
          count: items.length,
          accordionCount,
          itemCount,
          transcriptCount,
          href: location.href.slice(0, 240),
          sample: items.slice(0, 5).map((i) => ({
            title: i.title,
            accordion: i.accordionTitle,
          })),
        });

        sendResponse({
          ok: true,
          courseName,
          classesUrl: location.href,
          items,
          emptyDiag: items.length
            ? null
            : {
                count: itemCount,
                accordionCount,
                transcriptCount,
                hasAccordionsContainer: !!document.querySelector('.infnetci-accordions-container'),
                snippet: document.body
                  ? document.body.innerText.slice(0, 400).replace(/\s+/g, ' ')
                  : '',
              },
        });
      } catch (err) {
        L?.error?.('lessons', 'EXTRACT_LESSONS error', { error: err?.message || String(err) });
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  });
})();
