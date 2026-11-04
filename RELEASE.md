# Releasing Squadra

A release is three things: a `squadra-host` signed with the release key, a tag on `main`, and a GitHub Release.

Users install and update from the latest tag, not from `main`. Machines refuse a `squadra-host` that isn't signed, and they install the plugin from the tag of their own version (`roke22/Squadra#v<version>`). So a release isn't usable until its tag is pushed, and a tag can't be taken back once someone has used it.

## Once, before the first release

**The release key.** It already exists if `~/.config/squadra-release/release-key.pem` is there. Keep a backup somewhere safe, such as a password manager. It never goes in this repository or in CI: whoever gets into the repository would then have both the code and its signature. To make one for a fork:

```bash
mkdir -m 700 -p ~/.config/squadra-release
node scripts/release-sign.mjs keygen ~/.config/squadra-release/release-key.pem
```

Put the public key it prints in `RELEASE_PUBLIC_KEY` (`host/squadra-host.mjs`).

**Signing tags.** Git has to know what to sign with. With your SSH key:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/<your-key>.pub
```

Add the same public key on GitHub as a *signing key* (Settings → SSH and GPG keys), so that tags show as verified.

**Protecting tags.** In the repository, Settings → Rules → Rulesets, add a tag ruleset for `v*` that blocks updates and deletions. Nobody should be able to move a tag that machines install from.

## The release

Replace `X.Y.Z` with the new version and `A.B.C` with the current one.

### 1. Get `main` ready

Merge everything that goes in this release, including any pending Dependabot pull requests you have read and accept. Then see what changed:

```bash
git switch main && git pull
git log --oneline vA.B.C..
git switch -c release-X.Y.Z
```

The branch must be called `release-*`: that is what makes CI check the release.

### 2. Write what someone updating has to do

Add a note before the existing ones, after the **Updating:** / **Actualizar:** paragraph about machines, even if the note says there is nothing to do:

- `docs/reference.md`: `**From A.B.C:** ...`
- `docs/referencia.md`: `**Desde A.B.C:** ...`

Say what needs doing on the server, on the machines and in open sessions. Also check that the rest of the README and the reference describe this version, in both languages.

### 3. Prepare it

```bash
node scripts/release.mjs X.Y.Z
```

This sets the version in every file that has it, signs `squadra-host` and runs the tests. It commits nothing. Before changing anything, it refuses if the version is lower than the current one, the tag already exists, the key isn't the right one or the note from step 2 is missing.

If the key is somewhere else, pass its path as a second argument.

### 4. Open the pull request

```bash
git diff
git add host/squadra-host.mjs.sig && git commit -am "Squadra X.Y.Z"
git push -u origin HEAD
```

Open the pull request to `main`, titled `Squadra X.Y.Z`. CI runs the tests and checks the signature and the version.

If anything changes `host/squadra-host.mjs` after this point, run step 3 again with the same version and commit the new signature. Do the same if `main` moved and you merged it in.

### 5. Merge, check and tag

Merge the pull request, then:

```bash
git switch main && git pull
node scripts/release.mjs check X.Y.Z
git tag -s vX.Y.Z -m "Squadra X.Y.Z"
git push origin vX.Y.Z
```

Don't tag if the check fails: see [If something goes wrong](#if-something-goes-wrong). CI checks again on the tag, and the `release` job must be green before you go on.

### 6. Publish the GitHub Release

Create it from the tag, titled `Squadra vX.Y.Z`, either on GitHub or with:

```bash
gh release create vX.Y.Z --title "Squadra vX.Y.Z" --notes-file <notes-file> --verify-tag
```

Start the notes with a sentence on what the release brings, then a section per change, then what the note from step 2 says about updating. The README's release badge reads from here.

### 7. Try it for real

On a server you run:

```bash
git fetch --tags && git checkout "$(git tag --sort=-v:refname | head -1)"
```

Check that this lands on `vX.Y.Z`, then restart the server or rebuild its Docker image. On a machine:

```bash
squadra-host update
```

It must say `squadra-host updated: A.B.C → X.Y.Z`, install the plugin and restart the service. Open a session from the dashboard and send a message to another one.

## If something goes wrong

| What happens | What to do |
|---|---|
| `release.mjs` says the tests failed | The files already have the new version. Fix the problem and run it again with the same version |
| `check` fails on `main` after the merge | Something changed `squadra-host` after signing. Fix it in a new pull request from a `release-*` branch, running `release.mjs X.Y.Z` again, and tag after that merge |
| A machine says "the server has no signature for it" | That server isn't on a release, or it was built without `host/squadra-host.mjs.sig`. Put it on the latest tag |
| A machine says "its signature does not match" | The server's copy isn't the signed one. Find out why before going on: it can be a bad checkout, or a server that has been tampered with. Don't use `--allow-unsigned` until you know |
| A machine can't install the plugin | The tag isn't pushed, or doesn't have that version |
| The release is bad, and the tag is already pushed | Don't move or delete the tag. Fix it and publish a higher version. Machines refuse to go back unless they use `squadra-host update --allow-downgrade` |

## Changing the release key

**To replace it, while you still have the old one.** Make a new key, put its public key in `RELEASE_PUBLIC_KEY`, and sign with both:

```bash
node scripts/release.mjs X.Y.Z <new-key-file> <old-key-file>
```

Each machine checks with the key it has, and this version brings it the new one. Keep signing with both until every machine has updated. Signing with two keys only works from 0.0.7 on.

**If it was stolen.** Do the same, straight away, and stop using the old key as soon as every machine has updated. Until a machine updates it still trusts the old key, so tell users to update.

**If it was lost.** Make a new key and publish a release signed with it alone. Machines already installed won't accept it, so each one has to run `squadra-host update --allow-unsigned` once. Tell users in the release notes.
