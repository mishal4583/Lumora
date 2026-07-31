# Lumora — a glowkeeper story

A one-file HTML5 game built for **YouTube Playables**.

## Contents
- `index.html` — the complete game. No build step, no external assets, no network calls except the Playables SDK.

## Run locally
Open `index.html` in any browser, or serve it:
```
npx serve build
```
Outside the YouTube host the SDK is absent and all Playables calls no-op — the game runs standalone (best score falls back to localStorage).

## YouTube Playables integration
- Loads the SDK from `https://www.youtube.com/game_api/v1`
- `firstFrameReady()` + `gameReady()` fired after the first rendered frame
- `system.onPause / onResume` pause the loop and suspend audio
- `system.isAudioEnabled / onAudioEnabledChange` respected
- `game.saveData / loadData` persist the best score
- `engagement.sendScore` submitted on game over

## Publishing
1. Push this folder to your git repo.
2. Submit through the YouTube Playables partner process (games are onboarded via YouTube's partner program; there is no open self-serve upload yet).
3. The game is portrait 540×960 (letterboxes to any viewport), pointer/touch-only, no text input.
