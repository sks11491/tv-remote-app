'use strict';

/*
 * TV Video Remote -- server
 *
 *   [TV browser] --HTTP over Wi-Fi--> [this server] --> laptop's default player
 *
 * The TV is only the remote control. The video always plays on the laptop (or on
 * whatever display the laptop is sending to over HDMI).
 *
 * Security notes:
 *  - The browser never sends or receives a file path. It sends a button id, and
 *    the path is looked up in config.json by that id.
 *  - Players are launched with spawn + an argument array, never a shell string.
 */

var express = require('express');
var fs = require('fs');
var os = require('os');
var path = require('path');
var player = require('./lib/player');

var ROOT = __dirname;
var CONFIG_PATH = path.join(ROOT, 'config.json');

/* ------------------------------------------------------------------- config */

function loadConfig() {
  var raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    console.error('FATAL: cannot read config.json at ' + CONFIG_PATH);
    process.exit(1);
  }
  var cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error('FATAL: config.json is not valid JSON -- ' + e.message);
    if (/\\/.test(raw)) {
      console.error('Hint: write Windows paths with forward slashes (C:/Videos/intro.mp4)');
      console.error('      or doubled backslashes (C:\\\\Videos\\\\intro.mp4).');
    }
    process.exit(1);
  }

  cfg.port = cfg.port || 3000;
  cfg.playerPath = cfg.playerPath ? expandPath(cfg.playerPath) : '';
  cfg.playerArgs = Array.isArray(cfg.playerArgs) ? cfg.playerArgs : [];
  cfg.fullscreen = cfg.fullscreen !== false;
  cfg.hideControls = cfg.hideControls !== false;
  cfg.closeWhenDone = cfg.closeWhenDone !== false;
  cfg.endGraceSeconds = typeof cfg.endGraceSeconds === 'number' ? cfg.endGraceSeconds : 3;
  cfg.buttons = Array.isArray(cfg.buttons) ? cfg.buttons : [];

  // Base folders for relative paths. Both optional; absolute paths in a button
  // ignore them, so each video and icon can live anywhere on the laptop.
  var mediaDir = cfg.mediaDir ? path.resolve(ROOT, expandPath(cfg.mediaDir)) : ROOT;
  var iconDirs = cfg.iconDir
    ? [path.resolve(ROOT, expandPath(cfg.iconDir))]
    : [path.join(ROOT, 'public'), ROOT];   // "icons/1.svg" keeps working

  cfg.buttons.forEach(function (b) {
    if (!b) { return; }
    if (b.file) { b.resolvedFile = path.resolve(mediaDir, expandPath(b.file)); }
    if (b.icon) { b.resolvedIcon = resolveIcon(expandPath(b.icon), iconDirs); }
  });

  return cfg;
}

/*
 * Accept the path spellings people actually type:
 *   ~/Videos/intro.mp4            home folder
 *   %USERPROFILE%/Videos/a.mp4    Windows environment variables
 *   ${HOME}/Videos/a.mp4          POSIX-style environment variables
 */
function expandPath(p) {
  var s = String(p).trim();
  if (s === '~' || /^~[\\\/]/.test(s)) { s = os.homedir() + s.slice(1); }
  s = s.replace(/%([A-Za-z0-9_()]+)%/g, function (m, name) {
    var v = envVar(name);
    return v === undefined ? m : v;
  });
  s = s.replace(/\$\{([A-Za-z0-9_]+)\}/g, function (m, name) {
    var v = envVar(name);
    return v === undefined ? m : v;
  });
  return s;
}

// Environment lookup that is case-insensitive on Windows, like the shell.
function envVar(name) {
  if (process.env[name] !== undefined) { return process.env[name]; }
  if (process.platform !== 'win32') { return undefined; }
  var lower = name.toLowerCase();
  var key = Object.keys(process.env).filter(function (k) { return k.toLowerCase() === lower; })[0];
  return key ? process.env[key] : undefined;
}

function resolveIcon(icon, dirs) {
  if (path.isAbsolute(icon)) { return path.normalize(icon); }
  var hit = null;
  dirs.some(function (d) {
    var p = path.resolve(d, icon);
    if (fs.existsSync(p)) { hit = p; return true; }
    return false;
  });
  // Not found anywhere: keep the first candidate so the warning names a path.
  return hit || path.resolve(dirs[0], icon);
}

var ICON_TYPES = /\.(svg|png|jpe?g|gif|webp|bmp|ico|avif)$/i;

var config = loadConfig();

// id -> button, so /api/play/:id never has to trust client input beyond a lookup.
var buttonsById = {};
config.buttons.forEach(function (b) {
  if (b && b.id) { buttonsById[String(b.id)] = b; }
});

/* --------------------------------------------------------- startup selfcheck */

// Warn loudly about anything broken, but never crash: the operator should be
// able to start the server, see the TV page, and fix paths afterwards.
function selfCheck() {
  var problems = 0;

  if (!config.buttons.length) {
    console.warn('WARNING: config.json has no buttons.');
    problems++;
  }

  config.buttons.forEach(function (b) {
    if (!b.id || !b.label || !b.file) {
      console.warn('WARNING: button is missing id/label/file: ' + JSON.stringify(b));
      problems++;
      return;
    }
    if (!fs.existsSync(b.resolvedFile)) {
      console.warn('WARNING: [' + b.id + ' ' + b.label + '] file not found: ' + b.resolvedFile);
      problems++;
    }
    if (b.icon && !fs.existsSync(b.resolvedIcon)) {
      console.warn('WARNING: [' + b.id + ' ' + b.label + '] icon not found: ' + b.resolvedIcon);
      problems++;
    } else if (b.icon && !ICON_TYPES.test(b.resolvedIcon)) {
      console.warn('WARNING: [' + b.id + ' ' + b.label + '] icon is not an image file: ' +
                   b.resolvedIcon);
      problems++;
    }
  });

  if (config.playerPath && !fs.existsSync(config.playerPath)) {
    console.warn('WARNING: playerPath does not exist: ' + config.playerPath);
    problems++;
  }

  // Report which app will actually play, for the first button we can find.
  var sample = null;
  config.buttons.some(function (b) {
    if (b.resolvedFile) { sample = b.resolvedFile; return true; }
    return false;
  });

  var describe = sample
    ? player.describePlayerFor(sample, config.playerPath)
    : Promise.resolve('unknown (no files configured)');

  return describe.then(function (text) {
    console.log('Player:   ' + text);
    if (config.playerPath) {
      console.log('          (forced by "playerPath" in config.json)');
    } else {
      console.log('          (the laptop\'s default app for this file type)');
    }
    if (problems) {
      console.warn('\n' + problems + ' configuration warning(s) above. The server still runs;');
      console.warn('fix config.json and restart when convenient.\n');
    }
  });
}

/* ---------------------------------------------------------- playback state */

var current = null;    // the active player.Session, or null

// Stop whatever is playing. Safe to call when nothing is.
function stopCurrent() {
  if (!current) { return Promise.resolve(false); }
  var session = current;
  current = null;
  return session.stop().then(function () { return true; }).catch(function () { return false; });
}

/*
 * If the player goes away on its own -- the video ended and the player quit, or
 * someone closed the window on the laptop -- clear the banner so the TV stops
 * claiming something is playing. Cheap: no subprocess, just a liveness probe.
 */
setInterval(function () {
  if (current && !current.isAlive()) {
    console.log('Playback ended on its own [' + current.buttonId + ']');
    current = null;
  }
}, 2000).unref();

/* --------------------------------------------------------------------- app */

var app = express();

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public'), {
  // TV browsers cache aggressively; keep the page itself fresh during setup.
  setHeaders: function (res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

function iconUsable(b) {
  return !!(b && b.resolvedIcon && ICON_TYPES.test(b.resolvedIcon) &&
            fs.existsSync(b.resolvedIcon));
}

// The button list for the TV. Deliberately omits "file" and the icon's real
// path -- the client is never told where anything lives on disk.
app.get('/api/buttons', function (req, res) {
  res.json(config.buttons
    .filter(function (b) { return b && b.id; })
    .map(function (b) {
      var id = String(b.id);
      return {
        id: id,
        label: b.label || id,
        icon: iconUsable(b) ? 'api/icon/' + encodeURIComponent(id) : ''
      };
    }));
});

// Icons can live anywhere on the laptop, so they are served by button id --
// the same lookup-only rule as playback. Only configured image files go out.
app.get('/api/icon/:id', function (req, res) {
  var b = buttonsById[String(req.params.id)];
  if (!iconUsable(b)) { return res.status(404).end(); }
  res.sendFile(b.resolvedIcon, { dotfiles: 'allow', maxAge: 0 }, function (err) {
    if (err && !res.headersSent) { res.status(404).end(); }
  });
});

app.get('/api/status', function (req, res) {
  res.json({
    playing: current ? String(current.buttonId) : null,
    label: current ? current.label : null
  });
});

app.post('/api/play/:id', function (req, res) {
  var id = String(req.params.id);
  var button = buttonsById[id];

  if (!button) {
    return res.status(404).json({ ok: false, error: 'Unknown button: ' + id });
  }
  if (!fs.existsSync(button.resolvedFile)) {
    return res.status(500).json({
      ok: false,
      error: 'File not found on the laptop: ' + path.basename(button.resolvedFile)
    });
  }

  // Only one video at a time: the previous one is always stopped first.
  stopCurrent().then(function () {
    return player.play(button.resolvedFile, {
      buttonId: id,
      label: button.label || id,
      playerPath: config.playerPath,
      playerArgs: config.playerArgs,
      fullscreen: config.fullscreen,
      hideControls: config.hideControls,
      closeWhenDone: config.closeWhenDone,
      endGraceSeconds: config.endGraceSeconds
    });
  }).then(function (session) {
    // When we own the player process, clear the banner as soon as it exits.
    session.onExit = function (s) {
      if (current === s) { current = null; }
    };
    current = session;

    // spawn() reports a bad executable asynchronously, so give it a tick.
    return new Promise(function (resolve) { setTimeout(resolve, 150); }).then(function () {
      if (session.spawnError) {
        if (current === session) { current = null; }
        throw new Error('Could not start the player: ' + session.spawnError.message);
      }
      console.log('Playing [' + id + '] ' + (button.label || '') +
                  '  via ' + session.strategy.name);
      res.json({ ok: true, playing: id, label: button.label || id });
    });
  }).catch(function (err) {
    console.error('Play failed for [' + id + ']: ' + err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

app.post('/api/stop', function (req, res) {
  stopCurrent().then(function (stopped) {
    if (stopped) { console.log('Stopped playback'); }
    res.json({ ok: true, playing: null });
  }).catch(function (err) {
    res.status(500).json({ ok: false, error: err.message });
  });
});

/* ------------------------------------------------------------------ startup */

// Every address the TV could use to reach us.
function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ name: name, address: addr.address });
      }
    });
  });
  return out;
}

selfCheck().then(function () {
  // 0.0.0.0 so the TV on the same Wi-Fi (or the laptop's hotspot) can reach us.
  var server = app.listen(config.port, '0.0.0.0', function () {
    var addrs = lanAddresses();
    console.log('\n================ TV Video Remote ================');
    console.log('Open one of these on the TV browser:\n');
    if (addrs.length) {
      addrs.forEach(function (a) {
        console.log('   http://' + a.address + ':' + config.port + '   (' + a.name + ')');
      });
    } else {
      console.log('   (no LAN address found -- is Wi-Fi off?)');
    }
    console.log('\nOn this laptop:  http://localhost:' + config.port);
    console.log('\nIf the TV cannot connect, allow port ' + config.port +
                ' through the firewall (see README).');
    console.log('Press Ctrl+C to quit.');
    console.log('=================================================\n');
  });

  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.error('FATAL: port ' + config.port + ' is already in use. ' +
                    'Change "port" in config.json or close the other program.');
    } else {
      console.error('FATAL: ' + err.message);
    }
    process.exit(1);
  });
});

// Do not leave a video playing after the server is killed.
['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () {
    console.log('\nShutting down, stopping playback...');
    stopCurrent().then(function () { process.exit(0); });
    // Do not hang forever if the player refuses to die.
    setTimeout(function () { process.exit(0); }, 3000);
  });
});
