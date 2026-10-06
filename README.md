# TV Video Remote

Turn a smart TV into a **remote control** for videos that play on your **laptop**.

The TV opens a web page served by the laptop. The page shows five big icon
buttons. You move between them with the TV remote's D-pad and press **OK** — and
the laptop opens that video in **its own default media player**.

```
[TV browser] --HTTP over Wi-Fi--> [Laptop: Node server] --> laptop's default player --> video plays on the laptop
```

The TV never streams or decodes anything. All the media files stay on the
laptop, and the video appears on the laptop's screen (or on whatever display the
laptop is driving over HDMI).

---

## 1. Prerequisites

- **Node.js LTS** (v18 or newer) on the laptop — <https://nodejs.org>
- **A media player that the OS already associates with your video files.**
  Nothing to install or configure: the app uses whatever opens when you
  double-click an `.mp4` in Explorer / Finder / your file manager. (If that is
  VLC, mpv, Media Player, QuickTime — all fine.)
- The TV and the laptop on the **same Wi-Fi network**, or the TV joined to the
  **laptop's hotspot**.

## 2. Setup

```sh
npm install
# edit config.json -- point each button at a real video file
npm start
```

> **It works out of the box.** `media/` ships with five 20-second placeholder
> clips (a coloured card showing `1 INTRO`, `2 DEMO`, and so on) so you can test
> the whole flow before you have real content. Replace them with your own files,
> or point `config.json` somewhere else.

On startup the console prints which player it resolved and the URL(s) to open:

```
Player:   vlc.exe  ->  C:\Program Files\VideoLAN\VLC\vlc.exe
          (the laptop's default app for this file type)

================ TV Video Remote ================
Open one of these on the TV browser:

   http://192.168.1.23:3000   (Wi-Fi)

On this laptop:  http://localhost:3000
=================================================
```

### config.json

```json
{
  "port": 3000,
  "playerPath": "",
  "playerArgs": [],
  "fullscreen": true,
  "closeWhenDone": true,
  "endGraceSeconds": 3,
  "mediaDir": "",
  "iconDir": "",
  "buttons": [
    { "id": "1", "label": "Intro", "icon": "icons/1.svg", "file": "media/intro.mp4" },
    { "id": "2", "label": "Demo",  "icon": "D:/Event/logos/demo.png", "file": "D:/Event/videos/demo.mp4" },
    { "id": "3", "label": "Team",  "icon": "~/Pictures/team.jpg", "file": "%USERPROFILE%/Videos/team.mkv" }
  ]
}
```

| Key | Meaning |
|---|---|
| `port` | HTTP port. Change it if 3000 is taken. |
| `playerPath` | **Leave empty to use the laptop's default player.** Set it to a specific executable (e.g. `C:/Program Files/VideoLAN/VLC/vlc.exe`) to force that player instead. |
| `playerArgs` | Extra command-line arguments for the player. Overrides the automatic fullscreen flags. Only meaningful for players that have a command line. |
| `fullscreen` | Open the video fullscreen. Players with a command line get their fullscreen flag (VLC, mpv, mplayer, MPC-HC/BE, classic Windows Media Player, IINA). The Windows 11 **Media Player** and **Movies & TV** apps are switched to fullscreen by pressing their shortcut once the window appears. |
| `closeWhenDone` | Close the player when the video finishes (default `true`). The server reads the video's length and closes the player that long after it appears, so this works even for players that would sit on the last frame. |
| `endGraceSeconds` | Extra seconds to wait after the video's length before closing (default `3`). Raise it if the last moment gets cut off on a slow laptop. |
| `mediaDir` | Optional base folder for **relative** video paths. Empty means the project folder. |
| `iconDir` | Optional base folder for **relative** icon paths. Empty means `public/`, then the project folder. |
| `buttons[]` | Up to five for this MVP: `id`, `label`, `icon`, and `file`. |

**Videos and icons can live anywhere on the laptop**, on any drive, each in a
different folder if you like. Both `file` and `icon` accept:

- an **absolute** path: `D:/Event/videos/demo.mp4`
- a **relative** path, resolved against `mediaDir` / `iconDir`: `media/intro.mp4`
- your **home folder**: `~/Videos/intro.mp4`
- **environment variables**: `%USERPROFILE%/Videos/intro.mp4` or `${HOME}/Videos/intro.mp4`

Icons may be `.svg`, `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.ico` or `.avif`.
The TV fetches them through the server by button id, so their location on disk
is never revealed and no other file can be requested.

Missing files, missing icons and a bad `playerPath` are reported as warnings at
startup. The server still starts, so you can fix `config.json` and restart.

## 3. Connect the TV

1. Put the laptop and the TV on the **same Wi-Fi**.
2. Run `npm start` and note the printed `http://<ip>:3000` address.
3. Open the TV's web browser and type that address in.
4. **Bookmark it** — typing an IP with a remote once is enough for anyone.

## 4. Firewall

The TV cannot reach the laptop until the port is allowed through.

**Windows** — run once in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "TV Video Remote 3000" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
```

Or simply click **Allow access** on the "Windows Defender Firewall has blocked
some features of Node.js" prompt the first time you start the server, making
sure **Private networks** is ticked.

To remove the rule later:

```powershell
Remove-NetFirewallRule -DisplayName "TV Video Remote 3000"
```

## 5. Tips

- **Stop the laptop from sleeping.** A sleeping laptop is an unreachable server.
  Windows: **Settings → System → Power → Screen and sleep → Never** (while
  plugged in).
- **Keep the IP stable.** Reserve the laptop's address in your router's DHCP
  settings, or give it a static IP, so the TV bookmark keeps working after a
  reboot.
- **Use the HDMI display as the video output.** Make the HDMI screen the
  **primary** display (Windows: **Settings → System → Display → Multiple
  displays → Make this my main display**), because most players open fullscreen
  on the primary monitor.
- **Turn the laptop's volume up** before the event — this MVP has no volume
  control.
- A **phone or tablet** browser works as the remote too; the layout switches to
  one button per row.

## 6. Troubleshooting

**The TV cannot reach the server**
- Open the same URL on the laptop (`http://localhost:3000`) to confirm the
  server runs at all.
- Open it from a phone on the same Wi-Fi. If the phone works and the TV does
  not, the TV is on a different network (guest Wi-Fi and 2.4/5 GHz "band
  splitting" are the usual culprits).
- Check the firewall (section 4). This is the most common cause by far.
- Some routers have **AP isolation / client isolation** enabled, which blocks
  device-to-device traffic. Turn it off, or use the laptop's hotspot instead.
- Make sure you typed `http://`, not `https://`.

**"File not found on the laptop" / an icon is missing**
- The `file` or `icon` path in `config.json` is wrong. The startup warnings
  print the full path the server looked for. Use forward slashes even on
  Windows (`C:/media/intro.mp4`), or double the backslashes (`C:\\media\\...`).
- Restart the server after editing `config.json`.

**Nothing happens when I press OK**
- Look at the server console; every play attempt is logged there.
- Check that the file type actually has a default player — double-click the file
  in Explorer / Finder. If Windows shows the "How do you want to open this
  file?" picker, pick a player and tick **Always use this app**, then restart
  the server.

**The video plays on the wrong screen**
- Make the display you want the **primary** one (see section 5), or set
  `playerPath` to VLC and add its monitor flag, e.g.
  `"playerArgs": ["--fullscreen", "--play-and-exit", "--qt-fullscreen-screennumber=1"]`.

**The video does not open fullscreen (Windows 11 Media Player)**
- The server must bring the player window to the front to press its
  fullscreen key. Windows occasionally refuses; the console then says
  `Could not switch ... to fullscreen (no-focus)`. Pressing a button again
  usually works. For guaranteed fullscreen, set `playerPath` to VLC (below),
  which takes a `--fullscreen` flag.

**The player stays open after the video ends**
- The console says `Could not read the length of ...` when the video's
  duration is unknown. MP4/MOV lengths are read directly; other formats use
  Windows' own media properties. If Explorer shows no length for the file,
  convert it to MP4 or use VLC, which quits at the end on its own.

**Stop does not close the video**
- With a packaged Windows Store app (such as Windows 11 **Media Player**) there
  is no process to stop directly, so the app is found by its package and closed.
  That takes a second or two after launch. If it still misbehaves, set
  `playerPath` to a normal player — then the server owns the process and stop is
  instant:

  ```json
  "playerPath": "C:/Program Files/VideoLAN/VLC/vlc.exe"
  ```

**Port 3000 is already in use**
- Change `"port"` in `config.json`, and update the firewall rule to match.

---

## How it works

| Method | Route | Behaviour |
|---|---|---|
| GET | `/` | Serves `public/index.html` |
| GET | `/api/buttons` | `[{id, label, icon}]` — **never** the file paths; `icon` is an `/api/icon/:id` URL |
| GET | `/api/icon/:id` | The icon image configured for that button, wherever it is on disk |
| POST | `/api/play/:id` | Stops anything playing, then plays the file mapped to `id`. `{ok:true, playing:id}`, 404 for an unknown id, 500 with a readable message if the file or player is missing |
| POST | `/api/stop` | Stops playback |
| GET | `/api/status` | `{playing: id\|null, label}` |

**Choosing the player.** `playerPath` wins if set. Otherwise the OS file
association is resolved:

- **Windows** — the `UserChoice` ProgId (what you picked in *Open with → Always*),
  then the class default for the extension. If that yields a real executable the
  server spawns it directly. If it is a packaged Store app, the file is handed to
  the shell with `ShellExecute` and the app's processes are then located by their
  package.

**Safety.** The browser only ever sends a button **id**; paths are looked up in
`config.json` server-side, so a client can never ask for an arbitrary file.
Players are started with `spawn` and an argument **array** — never a
concatenated shell string — so there is nothing to inject into.

**One video at a time.** Pressing another button stops the current playback
before starting the next. Quitting the server with Ctrl+C stops playback too.

**Closing at the end.** Before launching, the server reads the video's length.
Once the player appears it starts a timer for that length plus
`endGraceSeconds`, then closes the player. VLC (`--play-and-exit`), MPC
(`/close`) and classic Windows Media Player (`/close`) also quit by themselves;
the timer is simply a backstop for them.

**Fullscreen for Store apps.** Windows 11 Media Player has no command line, so
the server finds its window (a Store app's window is owned by
`ApplicationFrameHost.exe`, with the app inside it), brings it to the front and
presses **F11**. It never sends the key unless the player's window has focus,
and skips it if the window already covers the screen.

**The banner corrects itself.** The server checks every two seconds whether the
player is still running, so closing the player window on the laptop, or the
player closing at the end of the video, clears "Now playing" on the TV.

## Project layout

```
tv-video-remote/
  server.js          HTTP API, config loading and validation, startup banner
  config.json        port, player options, the five buttons
  package.json
  lib/
    player.js        resolves the OS default player, launches it, stops it
  public/
    index.html
    style.css        TV-friendly dark layout (flexbox, no gap, no CSS vars)
    app.js           D-pad focus navigation, polling, banners (ES5)
    icons/           1.svg .. 5.svg placeholders
  media/             put your video files here (or point elsewhere in config)
  README.md
```
