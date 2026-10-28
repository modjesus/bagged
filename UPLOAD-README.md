# Hill pages: the real patch and the missing screenshot

28 Oct 2026. **WAITING to be uploaded. Not live yet.**

## What this fixes

1. **The app screenshot was missing on all 179 hill pages.** The pages
   asked for `waymark-marked-scafell.png` / `.webp`, and neither file was
   on the site (both returned "not found" on 28 Oct). They're in this
   folder now.
2. **The patch was a stand-in.** All 21 list pages drew a disc labelled
   "Set" even where the real artwork was already on the site. They now show
   the real patch. Today that's 4 of them: Wainwrights, Munros, Corbetts and
   National Three Peaks. The other 17 patches aren't drawn yet, so those
   pages keep the drawn disc, now labelled "Challenge" like the app.
   When one of those patches is drawn and uploaded to `/patches/`, its page
   picks it up by itself, with no rebuild.

Nothing else on any page changed. Each of the 21 pages is the live page
with only the patch changed.

## How to upload (one drag, 23 files)

1. Open your WayMark repository on GitHub.
2. Click **Add file → Upload files**.
3. From this folder, drag in **`hills`** (the whole folder) and the two
   **`waymark-marked-scafell`** files.
4. Click **Commit changes**.

Don't drag this README.

## Check afterwards

Open https://waymark.it.com/hills/wainwrights/. You should see the real
Wainwright patch, and the Scafell Pike screenshot under the orange button.
