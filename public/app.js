/*
 * TV Video Remote -- frontend
 *
 * Runs inside a smart-TV browser driven by a D-pad and OK. Deliberately plain:
 * ES5 only (var, no arrow functions, no template literals, no optional
 * chaining), XHR fallback when fetch is missing, and no libraries.
 *
 * Focus navigation is implemented by hand because TV browsers disagree about
 * (or simply do not do) spatial arrow-key navigation.
 */

(function () {
  'use strict';

  var POLL_MS = 2000;        // keep the banner in sync with the laptop
  var ERROR_HOLD_MS = 4000;  // how long a failure message stays put

  var bannerEl = document.getElementById('banner');
  var bannerTextEl = document.getElementById('banner-text');
  var gridEl = document.getElementById('grid');
  var loadingEl = document.getElementById('loading');

  var tiles = [];            // tile buttons, in config order
  var rows = [];             // focusables grouped into visual rows
  var playingId = null;
  var errorUntil = 0;        // timestamp; suppresses status updates until then

  /* ------------------------------------------------------------ transport */

  // Prefer fetch, fall back to XHR for older TV browsers. Always calls back
  // with (errorOrNull, parsedBodyOrNull).
  function request(method, url, cb) {
    if (typeof window.fetch === 'function') {
      window.fetch(url, { method: method, headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          return res.text().then(function (text) {
            var body = null;
            try { body = JSON.parse(text); } catch (e) { body = null; }
            if (!res.ok) {
              cb(new Error((body && body.error) || ('HTTP ' + res.status)), body);
            } else {
              cb(null, body);
            }
          });
        })
        .catch(function (err) { cb(err || new Error('network'), null); });
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }
      var body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        cb(null, body);
      } else {
        cb(new Error((body && body.error) || ('HTTP ' + xhr.status)), body);
      }
    };
    xhr.onerror = function () { cb(new Error('network'), null); };
    xhr.send();
  }

  /* --------------------------------------------------------------- banner */

  function setBanner(text, kind) {
    bannerTextEl.innerHTML = '';
    bannerTextEl.appendChild(document.createTextNode(text));
    bannerEl.className = 'banner banner-' + kind;
  }

  function showError(text) {
    errorUntil = new Date().getTime() + ERROR_HOLD_MS;
    setBanner(text, 'error');
  }

  // Reflect the server's view of what is playing.
  function renderPlaying(id, label) {
    playingId = id;
    var i;
    for (i = 0; i < tiles.length; i++) {
      var isActive = id !== null && tiles[i].getAttribute('data-id') === id;
      tiles[i].className = isActive ? 'tile tile-active' : 'tile';
    }
    if (new Date().getTime() < errorUntil) { return; }  // let the error stand
    if (id === null) {
      setBanner('Ready — pick a video', 'idle');
    } else {
      setBanner('Now playing: ' + (label || id), 'playing');
    }
  }

  /* ------------------------------------------------------ focus handling */

  // Group the focusable elements into visual rows by their vertical position.
  // Doing it from layout (rather than assuming 3 columns) keeps arrow keys
  // correct when the CSS reflows to one tile per row on a narrow screen.
  function buildRows() {
    var all = tiles;
    var buckets = [];
    var i, j;
    for (i = 0; i < all.length; i++) {
      var top = all[i].offsetTop;
      var placed = false;
      for (j = 0; j < buckets.length; j++) {
        if (Math.abs(buckets[j].top - top) < 30) {
          buckets[j].items.push(all[i]);
          placed = true;
          break;
        }
      }
      if (!placed) { buckets.push({ top: top, items: [all[i]] }); }
    }
    buckets.sort(function (a, b) { return a.top - b.top; });
    rows = buckets.map(function (b) { return b.items; });
  }

  // Where is the focused element in the row/column model?
  function locate(el) {
    var r, c;
    for (r = 0; r < rows.length; r++) {
      for (c = 0; c < rows[r].length; c++) {
        if (rows[r][c] === el) { return { row: r, col: c }; }
      }
    }
    return null;
  }

  function focusAt(row, col) {
    if (row < 0 || row >= rows.length) { return; }
    var target = rows[row];
    if (!target.length) { return; }
    if (col >= target.length) { col = target.length - 1; }
    if (col < 0) { col = 0; }
    target[col].focus();
  }

  function centerX(el) {
    return el.offsetLeft + (el.offsetWidth / 2);
  }

  // How far along its row an element sits, 0 (leftmost) to 1 (rightmost).
  function rowFraction(row, col) {
    var n = rows[row].length;
    return n > 1 ? col / (n - 1) : 0.5;
  }

  // Moving up or down picks the element in the target row that sits closest
  // horizontally, rather than reusing the column index. With a 3-then-2 layout
  // the rows have different lengths, so matching by position is what actually
  // feels right on a D-pad.
  //
  // A centred 3+2 grid produces exact ties -- tile 5 is the same distance from
  // tile 2 as from tile 3 -- so ties are broken towards the element holding the
  // same relative place in its row. That keeps movement reversible: down from
  // the last tile of row 1 and back up returns you where you started.
  function focusNearest(row, fromEl, fromRow, fromCol) {
    if (row < 0 || row >= rows.length) { return; }
    var candidates = rows[row];
    if (!candidates.length) { return; }
    var x = centerX(fromEl);
    var frac = rowFraction(fromRow, fromCol);
    var best = 0;
    var bestDist = Math.abs(centerX(candidates[0]) - x);
    var bestFrac = Math.abs(rowFraction(row, 0) - frac);
    var i;
    for (i = 1; i < candidates.length; i++) {
      var d = Math.abs(centerX(candidates[i]) - x);
      var f = Math.abs(rowFraction(row, i) - frac);
      // Within a pixel counts as a tie; fall back to relative position.
      if (d < bestDist - 1 || (Math.abs(d - bestDist) <= 1 && f < bestFrac)) {
        bestDist = d; bestFrac = f; best = i;
      }
    }
    candidates[best].focus();
  }

  function moveFocus(dx, dy) {
    buildRows();
    var active = document.activeElement;
    var at = locate(active);
    if (!at) {
      // Focus was lost (or on <body>) -- put it somewhere sensible.
      focusAt(0, 0);
      return;
    }
    if (dx !== 0) {
      focusAt(at.row, at.col + dx);   // left/right stays inside the row
    } else {
      focusNearest(at.row + dy, active, at.row, at.col);
    }
  }

  /* ------------------------------------------------------------- actions */

  function play(id, label) {
    // Optimistic banner so the TV feels responsive; the poll corrects it.
    setBanner('Starting: ' + label + '…', 'playing');
    request('POST', 'api/play/' + encodeURIComponent(id), function (err, body) {
      if (err) {
        showError(describeFailure(err));
        return;
      }
      errorUntil = 0;
      renderPlaying(String(body && body.playing ? body.playing : id), label);
    });
  }

  function stop() {
    request('POST', 'api/stop', function (err) {
      if (err) {
        showError(describeFailure(err));
        return;
      }
      errorUntil = 0;
      renderPlaying(null, null);
    });
  }

  function describeFailure(err) {
    var msg = err && err.message ? err.message : 'Unknown error';
    if (msg === 'network' || msg === 'Failed to fetch') {
      return 'Cannot reach laptop, check Wi-Fi';
    }
    return msg;
  }

  /* --------------------------------------------------------- build the UI */

  function makeTile(button) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile';
    el.setAttribute('data-id', button.id);
    el.setAttribute('tabindex', '0');

    if (button.icon) {
      var img = document.createElement('img');
      img.className = 'tile-icon';
      img.src = button.icon;
      img.alt = '';
      el.appendChild(img);
    }

    var label = document.createElement('span');
    label.className = 'tile-label';
    label.appendChild(document.createTextNode(button.label));
    el.appendChild(label);

    // Covers OK on remotes that synthesise a click, plus mouse/touch testing.
    el.onclick = function () { play(button.id, button.label); };

    return el;
  }

  function loadButtons() {
    request('GET', 'api/buttons', function (err, list) {
      if (err || !list || !list.length) {
        if (loadingEl) { loadingEl.innerHTML = ''; }
        showError(err ? describeFailure(err) : 'No buttons configured on the laptop');
        return;
      }
      if (loadingEl && loadingEl.parentNode) {
        loadingEl.parentNode.removeChild(loadingEl);
      }
      var i;
      for (i = 0; i < list.length; i++) {
        var tile = makeTile(list[i]);
        tiles.push(tile);
        gridEl.appendChild(tile);
      }
      buildRows();
      if (tiles.length) { tiles[0].focus(); }   // auto-focus the first button
      pollStatus();
    });
  }

  /* ------------------------------------------------------------- polling */

  function pollStatus() {
    request('GET', 'api/status', function (err, body) {
      if (err) {
        // Server unreachable: say so plainly, and keep retrying.
        setBanner('Cannot reach laptop, check Wi-Fi', 'error');
        errorUntil = 0;
        return;
      }
      var id = body && body.playing ? String(body.playing) : null;
      var label = body && body.label ? body.label : null;
      // Only repaint when something actually changed, so an in-flight
      // "Starting..." message is not clobbered on every tick.
      if (id !== playingId || new Date().getTime() >= errorUntil) {
        renderPlaying(id, label);
      }
    });
  }

  /* ------------------------------------------------------------- keyboard */

  // Remotes report the same buttons under different codes, so match on both
  // keyCode and the modern key name.
  function onKeyDown(e) {
    var code = e.keyCode || e.which;
    var key = e.key || '';

    // Left / Right / Up / Down
    if (code === 37 || key === 'ArrowLeft')  { e.preventDefault(); moveFocus(-1, 0); return; }
    if (code === 39 || key === 'ArrowRight') { e.preventDefault(); moveFocus(1, 0);  return; }
    if (code === 38 || key === 'ArrowUp')    { e.preventDefault(); moveFocus(0, -1); return; }
    if (code === 40 || key === 'ArrowDown')  { e.preventDefault(); moveFocus(0, 1);  return; }

    // OK / Enter -- activate whatever has focus.
    if (code === 13 || key === 'Enter') {
      e.preventDefault();
      var active = document.activeElement;
      if (active && active.getAttribute && active.getAttribute('data-id')) {
        var id = active.getAttribute('data-id');
        var labelEl = active.getElementsByClassName('tile-label')[0];
        play(id, labelEl ? labelEl.textContent || labelEl.innerText : id);
      } else if (tiles.length) {
        tiles[0].focus();
      }
      return;
    }

    // Stop: dedicated media key (413 on Tizen/webOS, 178 elsewhere),
    // plus Back / Escape (10009 Tizen, 461 webOS).
    if (code === 413 || code === 178 || key === 'MediaStop' ||
        code === 27 || key === 'Escape' ||
        code === 10009 || code === 461) {
      e.preventDefault();
      stop();
      return;
    }
  }

  /* ---------------------------------------------------------------- wire up */

  document.addEventListener('keydown', onKeyDown, false);

  // No pointer affordances on a TV.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
  document.addEventListener('selectstart', function (e) { e.preventDefault(); }, false);
  document.addEventListener('dragstart', function (e) { e.preventDefault(); }, false);

  // Keep the row model in step with the layout.
  window.onresize = function () { buildRows(); };

  // If the TV browser drops focus (e.g. after returning to the app), take it back.
  window.onfocus = function () {
    if (document.activeElement === document.body && tiles.length) { tiles[0].focus(); }
  };

  loadButtons();
  setInterval(pollStatus, POLL_MS);
})();
