'use strict';

/*
 * player.js -- plays a file with the LAPTOP'S DEFAULT PLAYER.
 *
 * "Default player" means whatever app the operating system has associated with
 * that file type (what you get when you double-click the file in Explorer /
 * Finder / your file manager). We never hardcode VLC.
 *
 * The hard part is not launching -- it is being able to STOP again, because the
 * app that ends up playing is usually NOT the process we spawned. So each
 * launch is resolved into one of these strategies, best first:
 *
 *   'exe'     The association points at a real executable (e.g. VLC, mpv).
 *             We spawn it directly, so we own the child process and stopping is
 *             instant and exact. This is the good case.
 *
 *   'appx'    Windows Store / packaged app (e.g. Windows 11 "Media Player").
 *             It is activated through COM, so there is no command line to
 *             spawn. We hand the file to the shell, then find the app's
 *             processes by the package they run from. Reliable, but takes a
 *             moment because packaged apps are slow to start.
 *
 *   'mac-app' macOS .app bundle, launched through `open -a`.
 *
 *   'shell'   Last resort: hand the file to the shell and watch for whichever
 *             new processes appear. Stopping is best-effort.
 *
 * Everything here uses argument ARRAYS, never a concatenated command string,
 * and the file path always comes from config.json -- never from the browser.
 */

var child_process = require('child_process');
var path = require('path');
var fs = require('fs');

var IS_WIN = process.platform === 'win32';
var IS_MAC = process.platform === 'darwin';

/* Command-line flags for players we recognise, keyed by executable name.
 *   always        added on every launch (mostly "quit when the file ends")
 *   fullscreen    added when config.fullscreen is on
 *   hideControls  added when config.hideControls is on
 * These only apply when the resolved player is in this table -- a packaged app
 * like the Windows 11 Media Player has no command line, so we cannot ask it
 * for anything. */
var PLAYER_FLAGS = {
  'vlc': {
    always: ['--play-and-exit', '--no-video-title-show'],
    fullscreen: ['--fullscreen'],
    // No interface at all: VLC opens straight into the video, with no control
    // bar, no on-screen messages and no mouse pointer.
    hideControls: ['-I', 'dummy', '--dummy-quiet', '--no-osd', '--mouse-hide-timeout=0']
  },
  'mpv': {
    fullscreen: ['--fullscreen'],
    hideControls: ['--no-osc', '--no-osd-bar', '--cursor-autohide=always']
  },
  'mplayer': { fullscreen: ['-fs'] },
  'mpc-hc': { always: ['/close'], fullscreen: ['/fullscreen'] },
  'mpc-hc64': { always: ['/close'], fullscreen: ['/fullscreen'] },
  'mpc-be': { always: ['/close'], fullscreen: ['/fullscreen'] },
  'mpc-be64': { always: ['/close'], fullscreen: ['/fullscreen'] },
  'wmplayer': { always: ['/play', '/close'], fullscreen: ['/fullscreen'] },
  'iina': { fullscreen: ['--fullscreen'] }
};

function flagsFor(key, opts) {
  var f = PLAYER_FLAGS[key];
  if (!f) { return []; }
  var out = (f.always || []).slice();
  if (opts.fullscreen && f.fullscreen) { out = out.concat(f.fullscreen); }
  if (opts.hideControls && f.hideControls) { out = out.concat(f.hideControls); }
  return out;
}

/* Packaged Windows apps have no command line, so fullscreen is requested the
 * way a person would: by pressing the app's fullscreen shortcut once its window
 * is up. Only packages whose shortcut we know are listed. */
var APPX_FULLSCREEN_KEYS = {
  'Microsoft.ZuneMusic': 'F11',       // Windows 11 "Media Player"
  'Microsoft.ZuneVideo': 'AltEnter'   // "Movies & TV" / "Films & TV"
};

/* Extension -> MIME, used only by the Linux xdg-mime lookup. */
var MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t'
};

/* ------------------------------------------------------------------ helpers */

// Promise wrapper around execFile. Never rejects: callers care about the output,
// and "this registry key does not exist" is an expected, boring outcome.
function run(cmd, args, timeout) {
  return new Promise(function (resolve) {
    child_process.execFile(
      cmd,
      args,
      { timeout: timeout || 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout) {
        resolve({ ok: !err, out: String(stdout || '') });
      }
    );
  });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Quote a string for PowerShell. Must NOT use JSON.stringify: PowerShell does
// not treat backslash as an escape character, so JSON's "C:\\dir" would arrive
// as a literal C:\\dir and match nothing. Single quotes are literal in
// PowerShell; the only escape needed is doubling an embedded quote.
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function toPidList(text) {
  return text.split(/\r?\n/)
    .map(function (s) { return parseInt(s.trim(), 10); })
    .filter(function (n) { return n > 0; });
}

// Split a registry / .desktop command template into argv, respecting quotes.
//   '"C:\\...\\vlc.exe" --started-from-file "%1"'
//     -> ['C:\\...\\vlc.exe', '--started-from-file', '%1']
function tokenizeCommand(line) {
  var out = [];
  var cur = '';
  var inQuotes = false;
  var i;
  for (i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (c === ' ' || c === '\t')) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) { out.push(cur); }
  return out;
}

// Replace the shell's field codes with the real file path. %1 %L %U (Windows)
// and %f %u (freedesktop) all mean "the file"; anything else is dropped.
function applyFieldCodes(args, filePath) {
  var out = [];
  var substituted = false;
  args.forEach(function (a) {
    if (/^%[1lLuUfF]$/.test(a)) {
      out.push(filePath);
      substituted = true;
    } else if (a.charAt(0) === '%') {
      // Unknown field code (%*, %D, %i, ...) -- not useful to us, skip it.
    } else {
      out.push(a);
    }
  });
  if (!substituted) { out.push(filePath); }
  return out;
}

/* --------------------------------------------- Windows registry association */

// `reg query` prints rows as:  "    ProgId    REG_SZ    AppXabc123"
// Pull out the value of valueName, or the key's default value when it is null.
function parseRegValue(out, valueName) {
  var lines = out.split(/\r?\n/);
  var wanted = valueName || '(Default)';
  var i;
  for (i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s{4,}(\(Default\)|\S+)\s+REG_[A-Z_]+\s+(.*)$/);
    if (m && m[1].toLowerCase() === wanted.toLowerCase()) {
      var value = m[2].trim();
      if (value) { return value; }
    }
  }
  return null;
}

function regQuery(keyPath, valueName) {
  var args = ['query', keyPath];
  args = args.concat(valueName ? ['/v', valueName] : ['/ve']);
  return run('reg.exe', args, 5000).then(function (r) {
    return r.ok ? parseRegValue(r.out, valueName) : null;
  });
}

// Which ProgIds claim this extension, most authoritative first. UserChoice is
// what the user actually picked via "Open with > Always use this app".
function windowsProgIds(ext) {
  var userChoice =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' +
    ext + '\\UserChoice';
  return regQuery(userChoice, 'ProgId').then(function (chosen) {
    return regQuery('HKCR\\' + ext, null).then(function (classDefault) {
      return [chosen, classDefault].filter(function (p) {
        // Validate before interpolating into another registry path.
        return p && /^[A-Za-z0-9_.\-]+$/.test(p);
      });
    });
  });
}

// Turn one ProgId into a launch strategy, or null if it yields nothing usable.
function windowsStrategyForProgId(progId) {
  var base = 'HKCR\\' + progId;
  return regQuery(base + '\\shell\\open\\command', null).then(function (cmd) {
    if (cmd) {
      var argv = tokenizeCommand(cmd);
      var exe = argv.shift();
      if (exe && /\.(exe|com|bat|cmd)$/i.test(exe)) {
        return {
          kind: 'exe',
          exe: exe,
          args: argv,
          name: path.basename(exe),
          progId: progId
        };
      }
    }
    // No usable command line -- is it a packaged (Store) app?
    return regQuery(base + '\\Application', 'AppUserModelID').then(function (aumid) {
      if (!aumid) { return null; }
      // 'Microsoft.ZuneMusic_8wekyb3d8bbwe!App'
      //   -> family 'Microsoft.ZuneMusic_8wekyb3d8bbwe'
      var family = aumid.split('!')[0];
      var parts = family.split('_');
      var pkgName = parts[0];
      var publisher = parts[parts.length - 1];
      if (!pkgName || !publisher || pkgName === publisher) { return null; }
      return regQuery(base + '\\Application', 'ApplicationName').then(function (label) {
        return {
          kind: 'appx',
          aumid: aumid,
          pkgName: pkgName,
          publisher: publisher,
          // Friendly names come back as '@{Package?ms-resource://...}', which is
          // unreadable, so fall back to the package name in that case.
          name: (label && label.charAt(0) !== '@') ? label : pkgName,
          progId: progId
        };
      });
    });
  });
}

function resolveWindows(ext) {
  return windowsProgIds(ext).then(function (progIds) {
    // Walk the candidates in order; take the first that resolves.
    return progIds.reduce(function (chain, progId) {
      return chain.then(function (found) {
        return found ? found : windowsStrategyForProgId(progId);
      });
    }, Promise.resolve(null));
  });
}

/* ----------------------------------------------------------- macOS / Linux */

function resolveMac(filePath) {
  // NSWorkspace knows the default app for a file. Nothing to install.
  var js =
    'ObjC.import("AppKit");' +
    'var u=$.NSURL.fileURLWithPath(' + JSON.stringify(filePath) + ');' +
    'var a=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(u);' +
    'a ? a.path.js : ""';
  return run('osascript', ['-l', 'JavaScript', '-e', js]).then(function (r) {
    var app = r.out.trim();
    if (!app || !fs.existsSync(app)) { return null; }
    return { kind: 'mac-app', app: app, name: path.basename(app, '.app') };
  });
}

function resolveLinux(ext) {
  var mime = MIME_BY_EXT[ext];
  if (!mime) { return Promise.resolve(null); }
  return run('xdg-mime', ['query', 'default', mime]).then(function (r) {
    var desktop = r.out.trim().split(/\s+/)[0];
    if (!desktop) { return null; }
    var dirs = [
      path.join(process.env.HOME || '', '.local/share/applications'),
      '/usr/share/applications',
      '/usr/local/share/applications',
      '/var/lib/flatpak/exports/share/applications'
    ];
    var hit = null;
    dirs.forEach(function (d) {
      if (hit) { return; }
      var p = path.join(d, desktop);
      if (fs.existsSync(p)) { hit = p; }
    });
    if (!hit) { return null; }
    var exec = null;
    String(fs.readFileSync(hit, 'utf8')).split(/\r?\n/).some(function (line) {
      var m = line.match(/^Exec\s*=\s*(.+)$/);
      if (m) { exec = m[1].trim(); return true; }
      return false;
    });
    if (!exec) { return null; }
    var argv = tokenizeCommand(exec);
    var exe = argv.shift();
    if (!exe) { return null; }
    return { kind: 'exe', exe: exe, args: argv, name: path.basename(exe) };
  });
}

/* ------------------------------------------------------- resolution + cache */

var resolveCache = {};

// Work out how to play filePath. playerPath from config always wins -- that is
// the documented escape hatch when the OS default is awkward.
function resolvePlayer(filePath, playerPath) {
  if (playerPath) {
    return Promise.resolve({
      kind: 'exe',
      exe: playerPath,
      args: [],
      name: path.basename(playerPath),
      forced: true
    });
  }
  var ext = path.extname(filePath).toLowerCase();
  if (resolveCache[ext]) { return Promise.resolve(resolveCache[ext]); }

  var p;
  if (IS_WIN) { p = resolveWindows(ext); }
  else if (IS_MAC) { p = resolveMac(filePath); }
  else { p = resolveLinux(ext); }

  return p.then(function (strategy) {
    // Nothing identifiable -- still playable via the shell, just harder to stop.
    var result = strategy || { kind: 'shell', name: 'system default' };
    resolveCache[ext] = result;
    return result;
  });
}

/* --------------------------------------------------------- process tracking */

// PIDs of processes running out of a given Store package.
function appxPids(pkgName, publisher) {
  var pattern = '*\\WindowsApps\\' + pkgName + '_*__' + publisher + '\\*';
  var ps =
    '$ErrorActionPreference="SilentlyContinue";' +
    'Get-Process | Where-Object { $_.Path -like ' + psLiteral(pattern) + ' } |' +
    'ForEach-Object { $_.Id }';
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000)
    .then(function (r) { return toPidList(r.out); });
}

// PIDs whose command line runs the binary inside a macOS .app bundle.
function macAppPids(appPath) {
  return run('pgrep', ['-f', path.join(appPath, 'Contents/MacOS/')])
    .then(function (r) { return toPidList(r.out); });
}

function allPids() {
  if (IS_WIN) {
    var ps = 'Get-Process | ForEach-Object { $_.Id }';
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000)
      .then(function (r) { return toPidList(r.out); });
  }
  return run('ps', ['-A', '-o', 'pid=']).then(function (r) { return toPidList(r.out); });
}

function killPid(pid) {
  if (IS_WIN) {
    // /T also takes down child processes, which packaged apps tend to spawn.
    return run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 5000);
  }
  return new Promise(function (resolve) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }
    resolve({ ok: true, out: '' });
  });
}

/* --------------------------------------------------------- video duration */

/*
 * Knowing how long the video is lets us close ANY player when it finishes,
 * including the ones that would otherwise sit on the last frame forever.
 * Resolves with seconds, or null when the length cannot be determined.
 */

// MP4 / MOV / M4V: read the 'mvhd' box directly. No external tools, and only a
// few header bytes are read even for multi-gigabyte files.
function mp4Duration(filePath) {
  var fd;
  try { fd = fs.openSync(filePath, 'r'); } catch (e) { return null; }
  try {
    var size = fs.fstatSync(fd).size;
    var hdr = Buffer.alloc(16);

    // Find the first box of `type` within [start, end). Returns {body, end}.
    var findBox = function (type, start, end) {
      var pos = start;
      while (pos + 8 <= end) {
        if (fs.readSync(fd, hdr, 0, 16, pos) < 8) { return null; }
        var boxSize = hdr.readUInt32BE(0);
        var boxType = hdr.toString('latin1', 4, 8);
        var headerLen = 8;
        if (boxSize === 1) {
          boxSize = Number(hdr.readBigUInt64BE(8));
          headerLen = 16;
        } else if (boxSize === 0) {
          boxSize = end - pos;            // box runs to the end of its parent
        }
        if (boxSize < headerLen) { return null; }  // corrupt
        if (boxType === type) { return { body: pos + headerLen, end: pos + boxSize }; }
        pos += boxSize;
      }
      return null;
    };

    var moov = findBox('moov', 0, size);
    if (!moov) { return null; }
    var mvhd = findBox('mvhd', moov.body, moov.end);
    if (!mvhd) { return null; }

    var b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, mvhd.body);
    var version = b.readUInt8(0);
    var timescale, duration;
    if (version === 1) {
      timescale = b.readUInt32BE(20);
      duration = Number(b.readBigUInt64BE(24));
    } else {
      timescale = b.readUInt32BE(12);
      duration = b.readUInt32BE(16);
    }
    if (!timescale || !duration) { return null; }
    return duration / timescale;
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

// Anything else: ask the OS, which already indexes media lengths.
function osDuration(filePath) {
  if (IS_WIN) {
    // Shell property System.Media.Duration, in 100 ns units. Covers every
    // format Windows has a property handler for (mkv, avi, wmv, ...).
    var ps =
      '$ErrorActionPreference="Stop";' +
      '$p=' + psLiteral(filePath) + ';' +
      '$sh=New-Object -ComObject Shell.Application;' +
      '$f=$sh.NameSpace([IO.Path]::GetDirectoryName($p)).ParseName([IO.Path]::GetFileName($p));' +
      '$d=$f.ExtendedProperty("System.Media.Duration");' +
      'if($d){[string]([double]$d/1e7)}';
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000)
      .then(function (r) { return parseFloat(r.out.trim()) || null; });
  }
  if (IS_MAC) {
    return run('mdls', ['-raw', '-name', 'kMDItemDurationSeconds', filePath])
      .then(function (r) { return parseFloat(r.out.trim()) || null; });
  }
  return run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                         '-of', 'default=noprint_wrappers=1:nokey=1', filePath])
    .then(function (r) { return parseFloat(r.out.trim()) || null; });
}

var durationCache = {};

function getDuration(filePath) {
  var key;
  try { key = filePath + '|' + fs.statSync(filePath).mtimeMs; } catch (e) { key = filePath; }
  if (durationCache[key]) { return Promise.resolve(durationCache[key]); }

  var quick = /\.(mp4|m4v|mov|3gp)$/i.test(filePath) ? mp4Duration(filePath) : null;
  var p = quick ? Promise.resolve(quick) : osDuration(filePath);
  return p.then(function (secs) {
    if (secs && secs > 0) { durationCache[key] = secs; return secs; }
    return null;
  }).catch(function () { return null; });
}

/* ------------------------------------------------- fullscreen (Windows apps) */

// Bring the player's window to the front and press its fullscreen shortcut.
// Never sends a key unless the player's window really has focus, so a stray
// keystroke cannot land in some other application.
//
// Store apps usually do not own their visible window: it belongs to
// ApplicationFrameHost.exe, with the app's content as a child window. So the
// target is any visible top-level window that either belongs to one of `pids`
// or contains a child window that does.
function windowsFullscreen(pids, keyName) {
  if (!pids.length) { return Promise.resolve('no-process'); }
  var key = keyName === 'AltEnter'
    ? '[W]::keybd_event(0x12,0,0,0);[W]::keybd_event(0x0D,0,0,0);' +
      '[W]::keybd_event(0x0D,0,2,0);[W]::keybd_event(0x12,0,2,0);'
    : '[W]::keybd_event(0x7A,0,0,0);[W]::keybd_event(0x7A,0,2,0);';
  var ps =
    '$ErrorActionPreference="SilentlyContinue";' +
    'Add-Type -AssemblyName System.Windows.Forms;' +
    'Add-Type @"\n' +
    'using System; using System.Runtime.InteropServices;\n' +
    'public struct R { public int L, T, Rt, B; }\n' +
    'public class W {\n' +
    ' public delegate bool P(IntPtr h, IntPtr l);\n' +
    ' [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);\n' +
    ' [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr w, P p, IntPtr l);\n' +
    ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n' +
    ' [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);\n' +
    ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\n' +
    ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n' +
    ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);\n' +
    ' [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);\n' +
    ' [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);\n' +
    ' [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);\n' +
    ' [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);\n' +
    ' [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);\n' +
    ' [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();\n' +
    // Windows only lets the process that owns the foreground hand focus away.
    // Joining the foreground thread's input queue, plus an Alt tap, are the
    // standard ways round that; a minimize/restore cycle is the last resort.
    ' public static bool Focus(IntPtr h, int attempt) {\n' +
    '  if (attempt >= 2) { ShowWindow(h, 6); ShowWindow(h, 9); }\n' +
    '  uint dummy; IntPtr fg = GetForegroundWindow();\n' +
    '  uint fgThread = GetWindowThreadProcessId(fg, out dummy);\n' +
    '  uint me = GetCurrentThreadId();\n' +
    '  bool joined = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);\n' +
    '  keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0);\n' +
    '  BringWindowToTop(h); SetForegroundWindow(h);\n' +
    '  if (joined) AttachThreadInput(me, fgThread, false);\n' +
    '  return GetForegroundWindow() == h; }\n' +
    ' public static IntPtr Find(uint[] want) {\n' +
    '  IntPtr found = IntPtr.Zero;\n' +
    '  EnumWindows(delegate (IntPtr h, IntPtr l) {\n' +
    '   if (!IsWindowVisible(h)) return true;\n' +
    '   R r; GetWindowRect(h, out r); if (r.Rt - r.L < 50 || r.B - r.T < 50) return true;\n' +
    '   uint top; GetWindowThreadProcessId(h, out top);\n' +
    '   bool hit = Array.IndexOf(want, top) >= 0;\n' +
    '   if (!hit) EnumChildWindows(h, delegate (IntPtr c, IntPtr l2) {\n' +
    '     uint p; GetWindowThreadProcessId(c, out p);\n' +
    '     if (Array.IndexOf(want, p) >= 0) { hit = true; return false; } return true; }, IntPtr.Zero);\n' +
    '   if (hit) { found = h; return false; } return true; }, IntPtr.Zero);\n' +
    '  return found; }\n' +
    '}\n' +
    '"@;' +
    '$ids=[uint32[]]@(' + pids.join(',') + ');' +
    '$h=[IntPtr]::Zero;' +
    // The window can show up a little after the process does.
    'for($i=0;$i -lt 40 -and $h -eq [IntPtr]::Zero;$i++){' +
    ' $h=[W]::Find($ids); if($h -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 250}' +
    '}' +
    'if($h -eq [IntPtr]::Zero){"no-window";exit}' +
    // Let the app finish opening the file; a keypress during load is ignored.
    'Start-Sleep -Milliseconds 800;' +
    'if([W]::IsIconic($h)){[W]::ShowWindow($h,9)|Out-Null}' +
    // Already covering the whole monitor? Then pressing the toggle would undo it.
    '$r=New-Object R;[W]::GetWindowRect($h,[ref]$r)|Out-Null;' +
    '$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;' +
    'if($r.L -le $s.Left -and $r.T -le $s.Top -and $r.Rt -ge $s.Right -and $r.B -ge $s.Bottom){"already";exit}' +
    '$ok=$false;' +
    'for($a=0;$a -lt 4 -and -not $ok;$a++){' +
    ' [W]::Focus($h,$a)|Out-Null;Start-Sleep -Milliseconds 300;' +
    ' $ok=([W]::GetForegroundWindow() -eq $h)' +
    '}' +
    'if(-not $ok){"no-focus";exit}' +
    key +
    '"ok"';
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 30000)
    .then(function (r) { return r.out.trim().split(/\r?\n/).pop() || 'failed'; });
}

/* ------------------------------------------------------------------ Session */

/*
 * One playback. session.pids fills in asynchronously for the appx/shell/mac-app
 * strategies, because those apps take a second or two to appear.
 */
function Session(buttonId, label, strategy) {
  this.buttonId = buttonId;
  this.label = label;
  this.strategy = strategy;
  this.child = null;
  this.launcher = null;
  this.pids = [];
  this.stopped = false;
  this.spawnError = null;
  this.onExit = null;
  this.onFirstPids = null;   // fired once, when the player's process is found
  this.closeTimer = null;
}

Session.prototype.probePids = function () {
  var s = this.strategy;
  if (s.kind === 'appx') { return appxPids(s.pkgName, s.publisher); }
  if (s.kind === 'mac-app') { return macAppPids(s.app); }
  return Promise.resolve([]);
};

Session.prototype.addPids = function (pids) {
  var self = this;
  var hadNone = !this.pids.length;
  pids.forEach(function (pid) {
    // Never target ourselves, whatever the process listing says.
    if (pid !== process.pid && self.pids.indexOf(pid) === -1) { self.pids.push(pid); }
  });
  if (hadNone && this.pids.length && !this.stopped && this.onFirstPids) {
    var cb = this.onFirstPids;
    this.onFirstPids = null;
    cb(this);
  }
};

// Close the player `seconds` from now -- i.e. when the video has finished.
Session.prototype.armAutoClose = function (seconds) {
  var self = this;
  if (this.stopped || !(seconds > 0)) { return; }
  if (this.closeTimer) { clearTimeout(this.closeTimer); }
  this.closeTimer = setTimeout(function () {
    self.closeTimer = null;
    if (self.stopped) { return; }
    console.log('Video finished [' + self.buttonId + '], closing the player');
    self.stop().then(function () {
      if (self.onExit) { self.onExit(self); }
    });
  }, Math.round(seconds * 1000));
  // Never keep the server alive just for this timer.
  if (this.closeTimer.unref) { this.closeTimer.unref(); }
};

// Watch for the real player's processes after a shell hand-off. Packaged apps
// can take several seconds to appear, so poll rather than sampling once.
Session.prototype.trackLate = function (baseline) {
  var self = this;
  var attempts = 0;
  var MAX_ATTEMPTS = 20;       // 20 * 400ms = 8s

  function tick() {
    if (self.stopped || attempts >= MAX_ATTEMPTS) { return; }
    attempts++;
    var probe;
    if (self.strategy.kind === 'shell') {
      probe = allPids().then(function (now) {
        return now.filter(function (pid) { return baseline.indexOf(pid) === -1; });
      });
    } else {
      probe = self.probePids();
    }
    probe.then(function (pids) {
      self.addPids(pids);
      return delay(400).then(tick);
    });
  }
  tick();
};

/*
 * Is this playback still going?
 *
 * Signal 0 kills nothing -- it just asks "does this process exist?" -- so this
 * is cheap enough to call on a timer, with no subprocess involved.
 *
 * Caveat for the appx/shell strategies: we can see that the player is still
 * running, but not whether it has reached the end of the file. A player left
 * open on the last frame still counts as playing. Closing the player window by
 * hand is detected, which is the case that matters in practice.
 */
Session.prototype.isAlive = function () {
  if (this.stopped) { return false; }

  if (this.child) {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  // Still inside the discovery window and nothing found yet -- assume alive, or
  // we would clear the banner before the player has had time to appear.
  if (!this.pids.length) { return true; }

  var alive = false;
  this.pids.forEach(function (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      // ESRCH: gone. EPERM: exists but owned by someone else -- still alive.
      if (e && e.code === 'EPERM') { alive = true; }
    }
  });
  return alive;
};

Session.prototype.stop = function () {
  var self = this;
  this.stopped = true;
  if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  var jobs = [];

  if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
    if (IS_WIN) { jobs.push(killPid(this.child.pid)); }
    else {
      try { this.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    }
  }

  // For appx/mac-app we may not have caught the PIDs yet (another button pressed
  // within a second of this one). Take one last look before killing.
  return this.probePids().then(function (extra) {
    self.addPids(extra);
    self.pids.forEach(function (pid) { jobs.push(killPid(pid)); });
    return Promise.all(jobs);
  }).then(function () { return true; });
};

/* ------------------------------------------------------------------- launch */

/*
 * Start playing filePath. Resolves with a Session.
 * opts: { buttonId, label, playerPath, playerArgs, fullscreen, hideControls,
 *         closeWhenDone, endGraceSeconds }
 */
function play(filePath, opts) {
  opts = opts || {};
  if (!fs.existsSync(filePath)) {
    return Promise.reject(new Error('File not found on the laptop: ' + filePath));
  }

  var grace = typeof opts.endGraceSeconds === 'number' ? opts.endGraceSeconds : 3;
  var durationP = opts.closeWhenDone ? getDuration(filePath) : Promise.resolve(null);

  return Promise.all([resolvePlayer(filePath, opts.playerPath), durationP]).then(function (got) {
    var strategy = got[0];
    var duration = got[1];
    var session = new Session(opts.buttonId, opts.label, strategy);
    session.duration = duration;

    if (opts.closeWhenDone && !duration) {
      console.warn('Could not read the length of ' + path.basename(filePath) +
                   '; the player will stay open after it finishes.');
    }

    if (strategy.kind === 'exe') {
      if (strategy.forced && !fs.existsSync(strategy.exe)) {
        throw new Error('playerPath in config.json does not exist: ' + strategy.exe);
      }
      var args = applyFieldCodes(strategy.args, filePath);
      // Ask for fullscreen only if we recognise this player's flag for it.
      var key = path.basename(strategy.exe).replace(/\.(exe|com)$/i, '').toLowerCase();
      var extra = flagsFor(key, opts);
      // An explicit playerArgs in config overrides our guess entirely.
      if (opts.playerArgs && opts.playerArgs.length) { extra = opts.playerArgs; }
      // Flags before the file path: most players require that order.
      args = extra.concat(args);

      var child = child_process.spawn(strategy.exe, args, {
        stdio: 'ignore',
        windowsHide: false,
        detached: false
      });
      session.child = child;
      child.on('error', function (err) { session.spawnError = err; });
      child.on('exit', function () {
        // The player quit by itself; the backstop timer is no longer needed.
        if (session.closeTimer) { clearTimeout(session.closeTimer); session.closeTimer = null; }
        if (session.onExit) { session.onExit(session); }
      });
      // Backstop for players that do not quit by themselves at the end. A
      // couple of extra seconds covers the player's own start-up time.
      if (opts.closeWhenDone && duration) { session.armAutoClose(duration + grace + 2); }
      return session;
    }

    // For the hand-off strategies the clock starts when the player appears.
    session.onFirstPids = function (s) {
      if (opts.closeWhenDone && duration) { s.armAutoClose(duration + grace); }

      var fsKey = strategy.kind === 'appx' ? APPX_FULLSCREEN_KEYS[strategy.pkgName] : null;
      if (opts.fullscreen && IS_WIN && fsKey) {
        windowsFullscreen(s.pids.slice(), fsKey).then(function (result) {
          if (result === 'ok') {
            console.log('Switched ' + strategy.name + ' to fullscreen');
          } else if (result !== 'already') {
            console.warn('Could not switch ' + strategy.name + ' to fullscreen (' + result + ')');
          }
        });
      }
    };

    // appx / shell / mac-app: hand the file to the OS, then find it afterwards.
    var needsBaseline = strategy.kind === 'shell';
    var pre = needsBaseline ? allPids() : Promise.resolve([]);

    return pre.then(function (baseline) {
      var cmd, cmdArgs;
      if (IS_WIN) {
        // ShellExecute without a shell: honours the association (including
        // packaged apps) and takes a plain argument array.
        cmd = 'rundll32.exe';
        cmdArgs = ['url.dll,FileProtocolHandler', filePath];
      } else if (IS_MAC) {
        cmd = 'open';
        cmdArgs = strategy.kind === 'mac-app'
          ? ['-n', '-a', strategy.app, filePath]
          : [filePath];
      } else {
        cmd = 'xdg-open';
        cmdArgs = [filePath];
      }

      var launcher = child_process.spawn(cmd, cmdArgs, {
        stdio: 'ignore',
        windowsHide: true,
        detached: false
      });
      launcher.on('error', function (err) { session.spawnError = err; });
      session.launcher = launcher;
      session.trackLate(baseline);
      return session;
    });
  });
}

/* Used by the startup self-check, so the console can say which app will play. */
function describePlayerFor(filePath, playerPath) {
  return resolvePlayer(filePath, playerPath).then(function (s) {
    if (s.kind === 'exe') { return s.name + '  ->  ' + s.exe; }
    if (s.kind === 'appx') { return s.name + '  (Windows packaged app)'; }
    if (s.kind === 'mac-app') { return s.name + '  ->  ' + s.app; }
    return 'system default (could not identify the app)';
  }).catch(function () { return 'unknown'; });
}

module.exports = {
  play: play,
  getDuration: getDuration,
  resolvePlayer: resolvePlayer,
  describePlayerFor: describePlayerFor
};
