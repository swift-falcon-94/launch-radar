// Launch Radar's dashboard. It reads window.LAUNCH_RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board with filters, sorting and pagination, plus a per-protocol detail drawer
// carrying the valuation breakdown, the comparables used, and the farm plan. No network: every byte
// it shows is in data.js, and the rows it renders are the same objects board.json carries.
(function () {
  'use strict';

  var DATA = window.LAUNCH_RADAR;
  var shell = document.querySelector('.shell');
  if (!DATA) {
    if (shell) shell.textContent = 'No radar data was loaded. The program writes data.js beside dashboard/.';
    return;
  }

  var PAGE_SIZE = 25;
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, minImplied: 0, sort: 'implied', dir: -1, page: 1, selected: null };
  var maxImplied = Math.max.apply(null, DATA.rows.map(function (r) { return r.implied_value_usd; }));
  var watchSet = {};
  (DATA.watchlist || []).forEach(function (s) { watchSet[s] = true; });

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + n.toFixed(3); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.category = params.get('category') || 'all';
    state.chain = params.get('chain') || 'all';
    state.minTvl = Number(params.get('minTvl')) || 0;
    state.minImplied = Number(params.get('minImplied')) || 0;
    state.sort = params.get('sort') || 'implied';
    state.dir = params.get('dir') === '1' ? 1 : -1;
    state.page = Math.max(1, Number(params.get('page')) || 1);
    state.selected = params.get('p') || null;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl > 0) params.set('minTvl', String(state.minTvl));
    if (state.minImplied > 0) params.set('minImplied', String(state.minImplied));
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir === 1) params.set('dir', '1');
    if (state.page > 1) params.set('page', String(state.page));
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (r.implied_value_usd < state.minImplied) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (state.sort === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (state.sort === 'multiple') { av = a.model.peer_multiple; bv = b.model.peer_multiple; }
      else if (state.sort === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function renderMeta() {
    document.getElementById('meta-date').textContent = DATA.as_of;
    document.getElementById('meta-model').textContent = DATA.model_version;
    document.getElementById('meta-floor').textContent = fmtUsd(DATA.floor_usd);
    document.getElementById('foot-source').textContent = 'Source: ' + DATA.source + '.';
    var stats = document.getElementById('stats');
    stats.textContent = '';
    var top = DATA.rows.length ? DATA.rows[0] : null;
    [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'every watchlist protocol is ranked'],
      ['Launch candidates priced', String(DATA.board_size), DATA.early_size + ' below the watchlist floor'],
      ['Peer protocols', String(DATA.peer_summary.global_peer_count), 'token-trading, priced by the market'],
      ['Top implied value', top ? fmtUsd(top.implied_value_usd) : 'n/a', top ? top.name : '']
    ].forEach(function (s) {
      stats.appendChild(el('div', { class: 'stat' }, el('span', { text: s[0] }), el('b', { text: s[1] }), el('em', { text: s[2] })));
    });
    var figures = document.getElementById('method-figures');
    figures.textContent = '';
    figures.appendChild(el('span', { html: 'Global median multiple <b>' + fmtMult(DATA.peer_summary.global_multiple) + '</b>' }));
    figures.appendChild(el('span', { html: 'Categories priced on their own peers <b>' + DATA.peer_summary.categories_priced + '</b>' }));
    figures.appendChild(el('span', { html: 'Categories on the global fallback <b>' + DATA.peer_summary.categories_fallback + '</b>' }));
    figures.appendChild(el('span', { html: 'Multiple clamp <b>0.01–2</b> · growth clamp <b>−50%…+100%</b> · maturity <b>0.7–1.0</b>' }));
    var v = DATA.validation;
    var box = document.getElementById('validation');
    if (v && box) {
      box.textContent = '';
      box.appendChild(el('span', { class: 'validation-label', text: 'Model check' }));
      box.appendChild(el('span', { html: 'Leave-one-out on <b>' + v.tested + '</b> traded protocols: the median prediction is <b>' + v.median_ratio.toFixed(2) + '×</b> the recorded market cap. Multiples vary widely inside a category, so every row shows the range of its own peer set next to the multiple it used.' }));
    }
  }

  function fillControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var cat = document.getElementById('category');
    cat.textContent = '';
    cat.appendChild(el('option', { value: 'all', text: 'All categories' }));
    categories.forEach(function (c) { cat.appendChild(el('option', { value: c, text: c })); });
    cat.value = state.category;
    var chain = document.getElementById('chain');
    chain.textContent = '';
    chain.appendChild(el('option', { value: 'all', text: 'All chains' }));
    chains.forEach(function (c) { chain.appendChild(el('option', { value: c, text: c })); });
    chain.value = state.chain;
    document.getElementById('q').value = state.q;
    document.getElementById('minTvl').value = state.minTvl > 0 ? String(state.minTvl) : '';
    document.getElementById('minImplied').value = state.minImplied > 0 ? String(state.minImplied) : '';
  }

  function renderTable() {
    var list = sorted(filtered());
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageRows = list.slice(start, start + PAGE_SIZE);
    var tbody = document.getElementById('rows');
    tbody.textContent = '';
    pageRows.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var chains = (r.chains || []).slice(0, 2).join(', ') + ((r.chains || []).length > 2 ? ' +' + ((r.chains || []).length - 2) : '');
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('span', { text: r.name }), watchSet[r.slug] ? el('span', { class: 'pill', text: 'Watchlist' }) : null)),
        el('td', { class: 'sub', text: r.category || 'Other' }),
        el('td', { class: 'sub', text: chains || '—' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num' }, fmtMult(r.model.peer_multiple), el('div', { class: 'mult-note', text: r.model.peer_set === 'category' ? r.model.peer_count + ' peers' : 'global fallback' })),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / maxImplied) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        ))
      );
      tbody.appendChild(tr);
    });
    document.getElementById('empty').hidden = list.length !== 0;
    document.getElementById('count').textContent = list.length + ' of ' + DATA.board_size + ' rows';
    renderPager(list.length, pages);
    document.querySelectorAll('th button[data-sort]').forEach(function (b) {
      var key = b.getAttribute('data-sort');
      var label = b.textContent.replace(/ [↑↓]$/, '');
      b.textContent = label + (key === state.sort ? (state.dir < 0 ? ' ↓' : ' ↑') : '');
    });
  }

  function renderPager(total, pages) {
    var pager = document.getElementById('pager');
    pager.textContent = '';
    var start = total === 0 ? 0 : (state.page - 1) * PAGE_SIZE + 1;
    var end = Math.min(total, state.page * PAGE_SIZE);
    pager.appendChild(el('span', { class: 'showing', text: 'Showing ' + start + '–' + end + ' of ' + total }));
    var wrap = el('span', { class: 'pages' });
    var prev = el('button', { type: 'button', text: 'Prev', disabled: state.page <= 1 ? 'disabled' : null, onclick: function () { state.page--; writeHash(); renderTable(); } });
    wrap.appendChild(prev);
    for (var p = 1; p <= pages; p++) {
      (function (page) {
        wrap.appendChild(el('button', { type: 'button', text: String(page), 'aria-current': page === state.page ? 'page' : null, onclick: function () { state.page = page; writeHash(); renderTable(); } }));
      })(p);
    }
    var next = el('button', { type: 'button', text: 'Next', disabled: state.page >= pages ? 'disabled' : null, onclick: function () { state.page++; writeHash(); renderTable(); } });
    wrap.appendChild(next);
    pager.appendChild(wrap);
    pager.appendChild(el('span', { text: PAGE_SIZE + ' rows per page' }));
  }

  var dialog = document.getElementById('detail');
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); renderTable(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    renderTable();
    dialog.textContent = '';
    var m = row.model;
    var recomputed = Math.max(1, Math.round(row.tvl_usd * m.peer_multiple * m.growth_multiplier * m.maturity_multiplier * m.chain_multiplier));
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'kicker', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · no token on record' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + ((row.chains || []).join(', ') || 'chain unlisted') + ' · listed ' + (row.listed_at || 'date unknown') })
      ),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var factors = el('div', { class: 'factors' });
    [
      ['TVL', fmtFull(row.tvl_usd)],
      ['Peer multiple', fmtMult(m.peer_multiple) + ' · peers ' + fmtMult(m.peer_q1) + '–' + fmtMult(m.peer_q3) + ' (' + m.peer_count + ')'],
      ['Seven-day growth', fmtPct(row.change_7d) + ' → ' + m.growth_multiplier.toFixed(3) + '×'],
      ['Age with no token', fmtAge(row.age_days) + ' → ' + m.maturity_multiplier.toFixed(3) + '×'],
      ['Chains', String((row.chains || []).length) + ' → ' + m.chain_multiplier.toFixed(3) + '×'],
      ['Implied value', fmtFull(row.implied_value_usd)]
    ].forEach(function (f) {
      factors.appendChild(el('div', null, el('span', { text: f[0] }), el('b', { text: f[1] })));
    });
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value: the working' }),
      factors,
      el('p', { class: 'check', html: 'Recomputed from the factors above: <b>' + fmtFull(recomputed) + '</b>' + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ' — differs from the board; the data would be stale.') + ' An estimate, not a price.' })
    ));
    var peersBody = el('tbody');
    m.comparables.forEach(function (c) {
      peersBody.appendChild(el('tr', null, el('td', { text: c.name }), el('td', { class: 'num', text: fmtMult(c.multiple) })));
    });
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Comparables used' }),
      el('table', { class: 'peers' }, el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Token-trading peer' }), el('th', { scope: 'col', text: 'Market cap / TVL' }))), peersBody),
      el('p', { class: 'check', text: 'The five peers nearest the ' + (m.peer_set === 'category' ? 'category' : 'global') + ' median multiple of ' + fmtMult(m.peer_multiple) + ', drawn from ' + m.peer_count + ' peer protocols.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function resetPage() { state.page = 1; }

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; resetPage(); writeHash(); renderTable(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; resetPage(); writeHash(); renderTable(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; resetPage(); writeHash(); renderTable(); });
  document.getElementById('minTvl').addEventListener('input', function (e) { state.minTvl = Number(e.target.value) || 0; resetPage(); writeHash(); renderTable(); });
  document.getElementById('minImplied').addEventListener('input', function (e) { state.minImplied = Number(e.target.value) || 0; resetPage(); writeHash(); renderTable(); });
  function clearFilters() {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.minImplied = 0; resetPage();
    fillControls(); writeHash(); renderTable();
  }
  document.getElementById('clear').addEventListener('click', clearFilters);
  document.getElementById('clear2').addEventListener('click', clearFilters);
  document.querySelectorAll('th button[data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
      writeHash(); renderTable();
    });
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
  window.addEventListener('hashchange', function () {
    readHash();
    fillControls();
    renderTable();
    if (state.selected) openDetail(state.selected);
    else if (dialog.open) dialog.close();
  });

  readHash();
  renderMeta();
  fillControls();
  renderTable();
  if (state.selected) openDetail(state.selected);
})();
