(() => {
  'use strict';

  const Y_TOLERANCE = 2.2;
  const money = value => Number(String(value ?? '').replace(/\s/g, '').replace(',', '.')) || 0;
  const normalized = value => String(value || '')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = value => normalized(value).replace(/[^A-ZА-Я0-9]/g, '');

  function joinParts(parts) {
    return [...parts]
      .sort((a, b) => a.x - b.x)
      .map(part => String(part.text ?? part.str ?? ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function groupTextItems(items, pageNumber = 1) {
    const groups = [];
    (items || []).forEach(item => {
      if (!item || typeof item.str !== 'string') return;
      const x = Number(item.transform?.[4]) || 0;
      const y = Number(item.transform?.[5]) || 0;
      let group = groups.find(candidate => Math.abs(candidate.y - y) < Y_TOLERANCE);
      if (!group) {
        group = { pageNumber, y, parts: [] };
        groups.push(group);
      }
      group.parts.push({ x, width: Number(item.width) || 0, text: item.str });
    });
    return groups
      .sort((a, b) => b.y - a.y)
      .map(group => ({ ...group, text: joinParts(group.parts) }))
      .filter(group => group.text);
  }

  function cleanPartner(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/([А-ЯA-Z])\s*\.\s*([А-ЯA-Z])\s*\./g, '$1.$2.')
      .trim();
  }

  function paymentByInvoice(invoice) {
    const value = normalized(invoice).replace(/[\s№#._-]/g, '');
    if (!value) return null;
    return /^[0OО]/i.test(value) ? 'cash' : /^\d+$/.test(value) ? 'cashless' : null;
  }

  function parseHeader(lines) {
    let invoice = '';
    let date = '';
    let partner = 'Партнёр не указан';

    for (const line of lines) {
      const lineKey = compact(line.text);
      if (!invoice && lineKey.includes('СЧЕТНАОПЛАТУ')) {
        const match = lineKey.match(/СЧЕТНАОПЛАТУ([0OО]?\d+)ОТ/i);
        if (match) invoice = match[1].replace(/\s/g, '');
        const dateMatch = line.text.match(/\sот\s*(.+)$/i);
        if (dateMatch) date = dateMatch[1].trim();
      }
      if (partner === 'Партнёр не указан' && lineKey.startsWith('ПОКУПАТЕЛЬ')) {
        const colon = line.text.indexOf(':');
        const value = colon >= 0 ? line.text.slice(colon + 1) : line.text.replace(/^\s*покупатель\s*/i, '');
        if (value.trim()) partner = cleanPartner(value);
      }
    }

    return { invoice, date, partner, payment: paymentByInvoice(invoice) };
  }

  function parseAnchor(line) {
    const numbered = line.text.match(/^(\d+)\s+(.+)$/);
    if (!numbered) return null;
    const tail = numbered[2].match(/^(.*?)(\d+(?:[.,]\d+)?)\s*(?:шт\.?|кг|л|ед\.?)?\s+(\d[\d\s]*(?:[.,]\d{2}))\s+(\d[\d\s]*(?:[.,]\d{2}))\s*$/i);
    if (!tail) return null;
    return {
      rowNumber: Number(numbered[1]),
      description: (tail[1] || '').trim(),
      qty: money(tail[2]),
      salePrice: money(tail[3]),
      total: money(tail[4]),
      pageNumber: line.pageNumber,
      y: line.y,
      sourceLine: line
    };
  }

  function tableSections(lines) {
    const sections = [];
    for (let index = 0; index < lines.length; index += 1) {
      const lineKey = compact(lines[index].text);
      if (!lineKey.includes('ТОВАРЫ') || !lineKey.includes('ЦЕНА') || !lineKey.includes('СУММА')) continue;
      let end = index + 1;
      while (end < lines.length && !compact(lines[end].text).startsWith('ИТОГОКОПЛАТЕ')) end += 1;
      sections.push(lines.slice(index + 1, end));
      index = Math.max(index, end - 1);
    }
    return sections;
  }

  function parseTable(lines) {
    const items = [];
    const sections = tableSections(lines);
    const sourceSections = sections.length ? sections : [lines];

    sourceSections.forEach(section => {
      const anchors = section.map(parseAnchor).filter(Boolean);
      if (!anchors.length) return;

      const fragments = section.filter(line => {
        if (parseAnchor(line)) return false;
        const lineKey = compact(line.text);
        return line.text && !lineKey.startsWith('ИТОГОКОПЛАТЕ') && !lineKey.startsWith('ВТОМЧИСЛЕНДС');
      });

      const descriptions = new Map(anchors.map(anchor => [anchor, []]));
      anchors.forEach(anchor => {
        if (anchor.description) descriptions.get(anchor).push({ y: anchor.y, text: anchor.description });
      });

      fragments.forEach(fragment => {
        const nearest = anchors.reduce((best, anchor) => {
          const distance = Math.abs(anchor.y - fragment.y);
          return !best || distance < best.distance ? { anchor, distance } : best;
        }, null);
        if (nearest) descriptions.get(nearest.anchor).push({ y: fragment.y, text: fragment.text });
      });

      anchors.forEach(anchor => {
        const description = descriptions.get(anchor)
          .sort((a, b) => b.y - a.y)
          .map(fragment => fragment.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!description || !anchor.qty || !anchor.salePrice) return;
        items.push({ description, qty: anchor.qty, salePrice: anchor.salePrice, lineTotal: anchor.total, rowNumber: anchor.rowNumber });
      });
    });

    return items;
  }

  function findInvoiceTotal(lines) {
    for (const line of lines) {
      if (!compact(line.text).startsWith('ИТОГОКОПЛАТЕ')) continue;
      const match = line.text.match(/(\d[\d\s]*(?:[.,]\d{2}))\s*$/);
      if (match) return money(match[1]);
    }
    return 0;
  }

  function parseInvoicePages(pages) {
    const lines = (pages || []).flatMap(page => Array.isArray(page) ? page : page.lines || []);
    const meta = parseHeader(lines);
    meta.invoiceTotal = findInvoiceTotal(lines);
    const items = parseTable(lines);
    const rows = items.map(item => ({ ...item, partner: meta.partner, payment: meta.payment }));
    return { rows, meta };
  }

  const api = { groupTextItems, parseInvoicePages, paymentByInvoice };
  if (typeof window !== 'undefined') window.KERN_PDF_PARSER = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

