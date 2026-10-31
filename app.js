(() => {
  'use strict';

  const data = window.KERN_CATALOG || { source: {}, items: [] };
  const catalog = data.items || [];
  const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const state = { mode: 'pdf', file: null, rows: [], meta: {}, reportText: '' };
  const $ = id => document.getElementById(id);
  const num = value => Number(String(value ?? '').replace(/\s/g, '').replace(',', '.')) || 0;
  const fmt = value => `${rub.format(Math.round(Number(value) || 0))} ₽`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const norm = value => String(value || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();

  function skuKey(value) {
    const map = {А:'A',В:'B',С:'C',Е:'E',Н:'H',К:'K',М:'M',О:'O',Р:'P',Т:'T',Х:'X',У:'Y'};
    return norm(value).replace(/[АВСЕНКМОРТХУ]/g, ch => map[ch]).replace(/[^A-Z0-9]/g, '');
  }

  function volumeKey(value) {
    const match = norm(value).replace(/\s/g, '').match(/(250МЛ|500МЛ|60МЛ|1Л|5Л|6КГ|20Л)/);
    return match ? match[1] : '';
  }

  function chooseByVolume(candidates, description) {
    if (!candidates.length) return null;
    const volume = volumeKey(description);
    if (volume) {
      const exact = candidates.find(item => volumeKey(`${item.name} ${item.sku}`) === volume);
      if (exact) return exact;
    }
    return candidates.length === 1 ? candidates[0] : candidates[candidates.length - 1];
  }

  function findCatalogByAlias(description) {
    const key = skuKey(description);
    const text = norm(description);
    let wanted = '';
    if (/RS700/.test(key)) wanted = 'RS700';
    else if (/RS500/.test(key)) wanted = 'RS500';
    else if (/RS650R?/.test(key)) wanted = 'RS650';
    else if (/ROBOT LINE/.test(text) && /(SUMMER SHIELD|NANO WAX|НАНО ВОСК)/.test(text)) wanted = 'RS900W';
    else if (/(SUMMER SHIELD|NANO WAX|НАНО ВОСК)/.test(text)) wanted = 'MX900W';
    else if (/КИСЛОТН.*ОЧИСТИТЕЛ.*БОКС/.test(text)) wanted = 'SQ700B';
    else if (/ЧЕР\S*.*(ПРЕМ|PREM)/.test(text)) wanted = 'GM700TD';
    else if (/\bM[- ]?3\b|\bМ[- ]?3\b/.test(text)) wanted = 'M3';
    if (!wanted) return null;
    return chooseByVolume(catalog.filter(item => skuKey(item.sku).includes(wanted)), description);
  }

  function matchCatalog(description) {
    const alias = findCatalogByAlias(description);
    if (alias) return { item: alias, confidence: 'high' };

    const key = skuKey(description);
    const exact = catalog.filter(item => {
      const candidate = skuKey(item.sku);
      return candidate.length >= 2 && /\d/.test(candidate) && key.includes(candidate);
    });
    if (exact.length) return { item: chooseByVolume(exact, description), confidence: 'high' };

    const stop = new Set(['KERN','GLOB','GLOBAL','TECH','PRO','ROBOT','LINE','СРЕДСТВО','АКТИВНАЯ']);
    const tokens = norm(description).split(/[^A-ZА-Я0-9]+/).filter(token => token.length > 3 && !stop.has(token));
    let best = null, score = 0;
    catalog.forEach(item => {
      const haystack = norm(`${item.name} ${item.sku}`);
      const hits = tokens.filter(token => haystack.includes(token)).length;
      const volumeBonus = volumeKey(description) && volumeKey(description) === volumeKey(item.name) ? 1 : 0;
      if (hits + volumeBonus > score) { score = hits + volumeBonus; best = item; }
    });
    return best && score >= 2 ? { item: best, confidence: 'medium' } : { item: null, confidence: 'none' };
  }

  function cashByInvoice(invoice) {
    return /^[0OО]/i.test(String(invoice || '').trim()) ? 'cash' : 'cashless';
  }

  function cleanPartner(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/([А-ЯA-Z])\s*\.\s*([А-ЯA-Z])\s*\./g, '$1.$2.')
      .trim();
  }

  function parseFreeText(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const rows = [];
    let partner = 'Партнёр не указан';
    let payment = null;
    lines.forEach(line => {
      if (/^[^:]{1,100}:$/.test(line)) {
        const header = line.replace(/:\s*$/, '').trim();
        const cashless = /-?7%|(?:\(|[-—/,])\s*(?:ПО\s+)?БЕЗ\s*НАЛ[А-ЯЁ]*\.?\s*\)?$/i.test(header);
        const cash = !cashless && /(?:\(|[-—/,])\s*(?:ЗА\s+)?НАЛ[А-ЯЁ]*\.?\s*\)?$/i.test(header);
        partner = header
          .replace(/\s*(?:\(\s*|[-—/,]\s*)(?:(?:ПО\s+)?БЕЗ\s*НАЛ[А-ЯЁ]*|(?:ЗА\s+)?НАЛ[А-ЯЁ]*|-?7%)\.?\s*\)?\s*$/i, '')
          .trim();
        payment = cashless ? 'cashless' : cash ? 'cash' : null;
        return;
      }
      const qtyMatch = line.match(/(\d+(?:[.,]\d+)?)\s*шт\.?/i);
      if (!qtyMatch) return;
      const qty = num(qtyMatch[1]) || 1;
      const description = line.slice(0, qtyMatch.index).replace(/^[-•]\s*/, '').trim();
      const tail = line.slice(qtyMatch.index + qtyMatch[0].length);
      const numbers = [...tail.matchAll(/(\d[\d\s]*(?:[.,]\d+)?)\s*(?:руб\.?|₽)?/gi)].map(match => num(match[1])).filter(Boolean);
      if (!numbers.length || !description) return;
      rows.push({ partner, payment, description, qty, salePrice: numbers[0] });
    });
    return { rows, meta: {} };
  }

  function parseInvoiceText(text) {
    const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
    const invoiceMatch = clean.match(/Сч[её]т\s+на\s+оплату\s*№\s*([^\s]+)\s+от/i);
    const dateMatch = clean.match(/Сч[её]т\s+на\s+оплату\s*№\s*[^\s]+\s+от\s+([^\n]+)/i);
    const invoice = invoiceMatch ? invoiceMatch[1].trim() : '';
    const buyerMatch = clean.match(/Покупатель\s*:\s*([^\n]+)/i);
    const partner = buyerMatch ? cleanPartner(buyerMatch[1]) : 'Партнёр не указан';
    const start = clean.search(/№\s+Товары|Товары\s*\(работы/i);
    const end = clean.search(/Итого\s+к\s+оплате/i);
    const block = start >= 0 ? clean.slice(start, end > start ? end : undefined) : clean;
    const tableLines = block.split('\n').map(line => line.trim()).filter(Boolean).slice(1);
    const items = [];
    let current = null, pending = [];
    const hasVolume = description => /\d+\s*(?:Л|КГ|МЛ)(?:\s|$)/i.test(description);
    const finish = () => {
      if (!current) return;
      current.description = current.description.replace(/\s+/g, ' ').trim();
      if (current.description) items.push(current);
      current = null;
    };
    tableLines.forEach(line => {
      if (/^Итого\s+к\s+оплате/i.test(line)) return;
      const numbered = line.match(/^(\d+)\s+(.+)$/);
      let parsed = null;
      if (numbered) {
        const tail = numbered[2].match(/^(?:(.*?)\s+)?(\d+(?:[.,]\d+)?)\s*(?:шт|кг|л)?\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s*$/i);
        if (tail) parsed = { description: (tail[1] || '').trim(), qty: num(tail[2]), salePrice: num(tail[3]) };
      }
      if (parsed) {
        finish();
        parsed.description = [...pending, parsed.description].filter(Boolean).join(' ');
        pending = [];
        current = parsed;
      } else if (current && !hasVolume(current.description)) current.description += ` ${line}`;
      else pending.push(line);
    });
    finish();
    return { rows: items.map(item => ({ ...item, partner, payment: cashByInvoice(invoice) })), meta: { invoice, date: dateMatch ? dateMatch[1].trim() : '', partner } };
  }

  async function readPdf(file) {
    const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const groups = [];
      content.items.forEach(item => {
        const x = item.transform[4], y = item.transform[5];
        let group = groups.find(candidate => Math.abs(candidate.y - y) < 2.2);
        if (!group) { group = { y, parts: [] }; groups.push(group); }
        group.parts.push({ x, text: item.str });
      });
      groups.sort((a,b) => b.y - a.y);
      pages.push(groups.map(group => group.parts.sort((a,b) => a.x - b.x).map(part => part.text).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    }
    return parseInvoiceText(pages.join('\n'));
  }

  function hydrateRows(parsed) {
    return parsed.rows.map((source, index) => {
      const match = matchCatalog(source.description);
      return { ...source, id: `${Date.now()}-${index}`, catalogRow: match.item?.row || null, confidence: match.confidence };
    });
  }

  function catalogItem(row) { return catalog.find(item => item.row === Number(row)) || null; }

  function itemShort(item) {
    const key = skuKey(item.sku);
    const labels = {
      RS700:'RS-700, фаза 1', RS500:'RS-500, фаза 2', RS650:'RS-650R, фаза 2',
      RS900W:'RS-900W, воск Robot Line', MX900W:'MX-900W, нано-воск', MX700:'MX-700, активная пена',
      GM700TD:'GM-700TD, чернение 5 л', SQ700B:'SQ-700B, очиститель боксов', M3:'М-3, керамика'
    };
    const exact = Object.keys(labels).find(alias => key.includes(alias));
    if (exact) return labels[exact];
    return `${item.sku} — ${String(item.name).toLocaleLowerCase('ru-RU')}`;
  }

  function calculateModel() {
    const valid = state.rows.filter(row => row.catalogRow && num(row.qty) > 0);
    const groupsMap = new Map();
    valid.forEach(row => {
      const item = catalogItem(row.catalogRow);
      const raw = (num(row.salePrice) - item.base) * num(row.qty);
      const calculated = { ...row, item, raw, counted: Math.max(0, raw), revenue: num(row.salePrice) * num(row.qty), baseTotal: item.base * num(row.qty) };
      const key = `${row.partner}|||${row.payment}`;
      if (!groupsMap.has(key)) groupsMap.set(key, { partner: row.partner, payment: row.payment, rows: [] });
      groupsMap.get(key).rows.push(calculated);
    });
    const groups = [...groupsMap.values()];
    const totalGross = groups.reduce((sum, group) => sum + group.rows.reduce((part, row) => part + row.counted, 0), 0);
    groups.forEach(group => {
      group.gross = group.rows.reduce((sum, row) => sum + row.counted, 0);
      group.tax = group.payment === 'cashless' ? Math.round(group.gross * .07) : 0;
      group.net = group.gross - group.tax;
    });
    return {
      groups,
      lines: valid.length,
      units: valid.reduce((sum,row) => sum + num(row.qty), 0),
      revenue: groups.reduce((sum,group) => sum + group.rows.reduce((part,row) => part + row.revenue, 0), 0),
      baseTotal: groups.reduce((sum,group) => sum + group.rows.reduce((part,row) => part + row.baseTotal, 0), 0),
      gross: totalGross,
      tax: groups.reduce((sum,group) => sum + group.tax, 0),
      net: groups.reduce((sum,group) => sum + group.net, 0)
    };
  }

  function buildPlainReport(model) {
    const lines = ['ОТЧЁТ ПО ПРОДАЖЕ'];
    if (state.meta.invoice) lines.push(`Счёт №${state.meta.invoice}${state.meta.date ? ` от ${state.meta.date}` : ''}`);
    lines.push('', 'Расчёт: количество × (продажа − БАСА) = маржа');
    model.groups.forEach((group, groupIndex) => {
      if (model.groups.length > 1 || !state.meta.invoice) lines.push('', `${group.partner} · ${group.payment === 'cashless' ? 'безнал (−7%)' : 'наличные'}`);
      else lines.push(`Партнёр: ${group.partner}`, `Оплата: ${group.payment === 'cashless' ? 'безнал (−7% от маржи)' : 'наличные'}`, '');
      group.rows.forEach(row => {
        const negative = row.raw < 0 ? ` · учтено 0 ₽ (фактически ${fmt(row.raw)})` : '';
        lines.push(`• ${itemShort(row.item)} (${rub.format(row.qty)} шт.): ${rub.format(row.qty)} × (${fmt(row.salePrice)} − ${fmt(row.item.base)}) = ${fmt(row.counted)}${negative}`);
      });
      if (model.groups.length > 1) {
        if (group.tax) lines.push(`  7% от маржи: −${fmt(group.tax)}`);
        lines.push(`  Итого ${group.partner}: ${fmt(group.net)}`);
      }
      if (groupIndex < model.groups.length - 1) lines.push('');
    });
    lines.push('', 'ИТОГО', `${model.lines} поз. · ${rub.format(model.units)} ед.`, `Продажа: ${fmt(model.revenue)}`, `БАСА: ${fmt(model.baseTotal)}`, `Маржа товаров: ${fmt(model.gross)}`);
    if (model.tax) lines.push(`Вычет 7%: −${fmt(model.tax)}`);
    lines.push(`ИТОГОВАЯ МАРЖА: ${fmt(model.net)}`);
    return lines.join('\n');
  }

  function renderReport(model) {
    $('resultEmpty').hidden = true;
    $('resultReady').hidden = false;
    $('copyReport').disabled = false;
    const invoiceLine = state.meta.invoice ? `<h3>СЧЁТ №${esc(state.meta.invoice)}</h3>` : '<h3>РАСЧЁТ ПРОДАЖИ</h3>';
    $('reportMeta').innerHTML = `${invoiceLine}<p>${esc(state.meta.date || new Intl.DateTimeFormat('ru-RU').format(new Date()))}</p><p>КОЛИЧЕСТВО × (ПРОДАЖА − БАСА) = МАРЖА</p>`;
    $('reportGroups').innerHTML = model.groups.map(group => {
      const rows = group.rows.map(row => `<div class="report-line"><span>${esc(itemShort(row.item))} (${rub.format(row.qty)} шт.)<small class="negative-note">${row.raw < 0 ? `Учтено 0 ₽ · фактически ${fmt(row.raw)}` : ''}</small></span><strong>${rub.format(row.qty)} × (${fmt(row.salePrice)} − ${fmt(row.item.base)}) = ${fmt(row.counted)}</strong></div>`).join('');
      return `<section class="report-group"><div class="report-group-head"><strong>${esc(group.partner)}</strong><span class="payment-badge">${group.payment === 'cashless' ? 'БЕЗНАЛ · −7%' : 'НАЛИЧНЫЕ'}</span></div>${rows}<div class="group-subtotal"><div><span>МАРЖА ТОВАРОВ</span><strong>${fmt(group.gross)}</strong></div><div><span>ВЫЧЕТ 7%</span><strong>${fmt(group.tax)}</strong></div><div><span>ИТОГО ПАРТНЁРА</span><strong>${fmt(group.net)}</strong></div></div></section>`;
    }).join('');
    const tax = model.tax ? `<div class="summary-row"><span>Вычет 7%</span><strong>−${fmt(model.tax)}</strong></div>` : '';
    $('reportTotal').innerHTML = `<div class="summary-row"><span>${model.lines} поз. · ${rub.format(model.units)} ед.</span><strong>Продажа ${fmt(model.revenue)}</strong></div><div class="summary-row"><span>Цена отгрузки БАСА</span><strong>${fmt(model.baseTotal)}</strong></div><div class="summary-row"><span>Маржа товаров</span><strong>${fmt(model.gross)}</strong></div>${tax}<div class="summary-row final"><span>ИТОГОВАЯ МАРЖА</span><strong>${fmt(model.net)}</strong></div>`;
    state.reportText = buildPlainReport(model);
  }

  function renderReview() {
    const uncertain = state.rows.filter(row => !row.catalogRow || row.confidence !== 'high');
    $('reviewPanel').hidden = uncertain.length === 0;
    $('reviewRows').innerHTML = uncertain.map(row => `<div class="review-row" data-id="${row.id}"><label>${esc(row.description)}<br><small>${rub.format(row.qty)} шт · ${fmt(row.salePrice)} / ед.</small></label><select>${catalogOptions(row.catalogRow)}</select></div>`).join('');
  }

  function catalogOptions(selected) {
    return `<option value="">— Выберите позицию —</option>` + catalog.map(item => `<option value="${item.row}" ${item.row === Number(selected) ? 'selected' : ''}>${esc(item.sku)} · ${esc(item.name)} · БАСА ${fmt(item.base)}</option>`).join('');
  }

  async function calculate() {
    $('inputError').textContent = '';
    $('resultReady').hidden = true;
    $('resultEmpty').hidden = false;
    $('copyReport').disabled = true;
    state.reportText = '';
    $('calculate').disabled = true;
    $('calculate').firstElementChild.textContent = 'РАСЧЁТ…';
    try {
      let parsed;
      if (state.mode === 'pdf') {
        if (!state.file) throw new Error('Сначала выберите счёт в PDF.');
        parsed = await readPdf(state.file);
        if (!parsed.rows.length) throw new Error('Не удалось выделить товарные позиции из PDF.');
      } else {
        parsed = parseFreeText($('salesText').value);
        if (!parsed.rows.length) throw new Error('Не нашёл строки вида «Товар 2 шт — 1500 руб.».');
        const unspecified = [...new Set(parsed.rows.filter(row => !row.payment).map(row => row.partner))];
        if (unspecified.length) throw new Error(`Укажите способ оплаты в заголовке: ${unspecified.map(name => `${name} (нал) или ${name} (безнал)`).join('; ')}.`);
      }
      state.meta = parsed.meta;
      state.rows = hydrateRows(parsed);
      renderReview();
      const model = calculateModel();
      if (!model.lines) throw new Error('Ни одна позиция пока не сопоставлена с матрицей БАСА. Проверьте блок ниже.');
      renderReport(model);
    } catch (error) {
      console.error(error);
      $('inputError').textContent = error.message || 'Не удалось выполнить расчёт.';
    } finally {
      $('calculate').disabled = false;
      $('calculate').firstElementChild.textContent = 'РАССЧИТАТЬ';
    }
  }

  document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    document.querySelectorAll('.mode').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-selected', item === button ? 'true' : 'false'); });
    $('textMode').classList.toggle('active', state.mode === 'text');
    $('pdfMode').classList.toggle('active', state.mode === 'pdf');
    $('paymentMode').textContent = state.mode === 'pdf' ? 'Определяется автоматически' : 'Укажите у каждого партнёра';
    $('inputError').textContent = '';
  }));

  $('pdfInput').addEventListener('change', event => selectFile(event.target.files[0]));
  $('dropZone').addEventListener('dragover', event => { event.preventDefault(); $('dropZone').classList.add('dragging'); });
  $('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('dragging'));
  $('dropZone').addEventListener('drop', event => { event.preventDefault(); $('dropZone').classList.remove('dragging'); selectFile(event.dataTransfer.files[0]); });
  function selectFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { $('inputError').textContent = 'Нужен файл в формате PDF.'; return; }
    state.file = file;
    $('fileTitle').textContent = file.name;
    $('fileNote').textContent = `${(file.size / 1024).toFixed(0)} КБ · готов к расчёту`;
    $('inputError').textContent = '';
  }

  $('calculate').addEventListener('click', calculate);
  $('recalculate').addEventListener('click', () => {
    document.querySelectorAll('.review-row').forEach(element => {
      const row = state.rows.find(item => item.id === element.dataset.id);
      if (row) { row.catalogRow = num(element.querySelector('select').value) || null; row.confidence = row.catalogRow ? 'high' : 'none'; }
    });
    renderReview();
    const model = calculateModel();
    if (model.lines) renderReport(model);
  });
  $('copyReport').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.reportText); }
    catch { const area = document.createElement('textarea'); area.value = state.reportText; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); }
    const button = $('copyReport'); button.textContent = 'СКОПИРОВАНО'; setTimeout(() => button.textContent = 'КОПИРОВАТЬ', 1400);
  });

})();

