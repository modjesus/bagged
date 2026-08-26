# Bagged

A hill-bagging log for the 214 Wainwrights and the 137 Hewitts of Wales.
Runs as an installable web app: works offline, syncs between devices through
a private GitHub repository you own.

## What's here

| File | What it is |
|---|---|
| `index.html` | The whole app — hill data, map, photos, routes |
| `manifest.webmanifest` | Makes it installable to a home screen |
| `sw.js` | Service worker, so it works with no signal |
| `icon-*.png` | App icons |

## Setup

**1. Public repo for the app.** Create a repo called `bagged`, public, and
upload every file here to it. Then Settings → Pages → Source: *Deploy from a
branch*, branch `main`, folder `/ (root)`. After a minute the app is live at
`https://<your-username>.github.io/bagged/`.

It has to be public because GitHub Pages only serves public repos on a free
account. No personal data lives in it — only the app itself.

**2. Private repo for the log.** Create a second repo called `bagged-log`,
**private**, and tick "Add a README file" so it isn't empty. This is where your
ticks, dates, notes and photos are stored. Nobody but you can read it.

**3. A token so the app can write to it.** GitHub → your avatar → Settings →
Developer settings → Personal access tokens → **Fine-grained tokens** →
Generate new token.

- Repository access: **Only select repositories** → `bagged-log`
- Permissions → Repository permissions → **Contents: Read and write**
- Expiration: whatever you like — you'll need a new one when it lapses

Copy the token (`github_pat_…`). It's shown once.

**4. Connect.** Open the app, tap the pill in the top right, and enter your
username, `bagged-log`, and the token. Repeat on each device you use.

## How syncing works

Every change is written to this device first, so the app never waits on a
network and works fine on a summit with no signal. A few seconds later it
pulls the log from GitHub, merges it with yours, and pushes the result back.
Where the same hill was edited on two devices, the more recent edit wins.

Photos are shrunk to around 200KB and committed to `photos/` in the private
repo. Other devices download them on demand and cache them locally.

## Updating the app

Replace `index.html` in the public repo. Bump `CACHE` in `sw.js` at the same
time (`bagged-v1` → `bagged-v2`) or browsers will keep serving the old one.

## The token, honestly

The token lives in your browser's local storage on each device you connect.
That's fine for your own phone and laptop. It only ever grants access to the
one private repo you scoped it to, so the worst case is someone reading your
hill log. If you lose a device, delete the token on GitHub and it's dead.
