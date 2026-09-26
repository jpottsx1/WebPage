(function () {
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function mount(root, data) {
    var byId = {}; data.entries.forEach(function (e) { byId[e.id] = e; });
    var key = 'sgeulai-companion:' + data.title;
    root.classList.add('sgc'); root.replaceChildren();
    var bar = el('div', 'sgc-bar');
    var label = el('label', null, 'I’ve read up to');
    var upto = el('select'); upto.id = 'sgc-upto-' + Math.random().toString(36).slice(2); label.htmlFor = upto.id;
    data.stops.forEach(function (s, i) { var o = el('option', null, s.label); o.value = i; upto.appendChild(o); });
    var find = el('input'); find.type = 'search'; find.placeholder = 'Find a name'; find.setAttribute('aria-label', 'Find a name');
    bar.append(label, upto, find);
    var note = el('p', 'sgc-note', 'Nothing past the chapter you choose is shown. Your choice stays on this device.');
    var list = el('div', 'sgc-list'); list.setAttribute('aria-live', 'polite');
    root.append(bar, note, list);
    var saved = 0; try { saved = Number(localStorage.getItem(key) || 0); } catch (e) {}
    upto.value = String(Math.min(saved, Math.max(0, data.stops.length - 1)));
    function render() {
      var at = Number(upto.value), q = find.value.trim().toLowerCase();
      try { localStorage.setItem(key, String(at)); } catch (e) {}
      list.replaceChildren();
      var shown = data.entries.filter(function (e) { return e.from <= at && (!q || e.name.toLowerCase().indexOf(q) >= 0); });
      if (!shown.length) list.appendChild(el('p', 'sgc-note', q ? 'No one by that name yet.' : 'No one yet — read on.'));
      shown.forEach(function (e) {
        var card = el('section', 'sgc-entry'); card.id = 'sgc-' + e.id;
        card.append(el('div', 'sgc-kind', e.kind), el('h3', 'sgc-name', e.name),
                    el('div', 'sgc-meta', 'First met in ' + data.stops[e.from].label));
        if (e.blurb) card.appendChild(el('p', 'sgc-blurb', e.blurb));
        var links = e.links.filter(function (l) { return l.from <= at && byId[l.id]; }).slice(0, 8);
        if (links.length) {
          var p = el('p', 'sgc-meta sgc-links'); p.appendChild(document.createTextNode('Seen with: '));
          links.forEach(function (l, i) {
            var a = el('a', null, byId[l.id].name); a.href = '#sgc-' + l.id; p.appendChild(a);
            if (i < links.length - 1) p.appendChild(document.createTextNode(', '));
          });
          card.appendChild(p);
        }
        list.appendChild(card);
      });
    }
    upto.addEventListener('change', render); find.addEventListener('input', render); render();
  }
  function start() {
    document.querySelectorAll('[data-sgeulai-companion]').forEach(function (root) {
      var inline = root.getAttribute('data-inline');
      if (inline) { mount(root, JSON.parse(document.getElementById(inline).textContent)); return; }
      fetch(root.getAttribute('data-src') || 'companion.json')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (data) { mount(root, data); })
        .catch(function () { root.textContent = 'The companion could not be loaded.'; });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();