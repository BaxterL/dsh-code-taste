# Publishing

The DeepSeek Harness ecosystem has **no official marketplace**. "Publishing to the
community market" means two separate things:

1. publish the package to npm, and
2. get an index entry into one or more community indexes.

The market tab inside DSH (Discover) only lists the indexes a user adds, so an npm
release is what actually makes the plugin installable and discoverable.

## 1. npm

```sh
node test/harness.mjs          # 39 checks, drives apply(ctx) with a fake ctx
npm pack --dry-run             # check the file list before publishing
npm publish --access public    # prompts for the 6-digit 2FA code
```

`package.json` pins `publishConfig.registry` to `https://registry.npmjs.org/`, so a machine whose
global registry is a mirror (npmmirror, Verdaccio) still publishes to npm and not to the mirror.
That pin is the only reason a plain `npm publish` is enough here — do not remove it.

npm requires 2FA on the account or a granular access token with bypass 2FA. Interactive publishing
is the intended path: the CLI asks for the 6-digit code, which takes a one-time password from the
authenticator app. Recovery codes work in the browser 2FA prompt, not on the command line.

The registry processes a publish asynchronously: the CLI prints
`Your package is being processed and may take a few minutes to become available` and the version
shows up one to two minutes later. Until then the registry still serves the previous `latest`, and a
second publish of the same version answers `E409 Cannot publish over previously staged version` —
that is an in-flight publish, not a stuck staged package. Wait, then verify:

```sh
npm view dsh-code-taste version
npm view dsh-code-taste dsh
```

A brand-new package name first materialises as a public placeholder, `0.0.0-stage`
("Temporary package placeholder for staged publishing"). It is harmless: it stays in the versions
list, but `latest` moves to the real release and nobody installs the placeholder.

## 2. Community indexes

| Index | How to get listed |
| --- | --- |
| `realoiyo/dsh-plugin-market` (`https://realoiyo.github.io/dsh-plugin-market/index.json`) | rebuilt daily from npm — **no PR needed**, it appears after the next rebuild |
| `polang233/dsh-plugin-index` (`https://polang233.github.io/dsh-plugin-index/index.json`) | curated — open a PR adding one entry |
| `awesome-deepseek-harness` lists | open a PR adding a line under the plugins section |

For a curated index, copy an existing entry and replace the fields. The shape used by
format 1 is roughly:

```json
{
  "name": "dsh-code-taste",
  "version": "0.3.0",
  "description": {
    "en": "Learns your coding taste and applies it in every session.",
    "zh": "学习你的代码品味，并在每个会话里照着写。"
  },
  "repository": "https://github.com/BaxterL/dsh-code-taste",
  "install": "dsh-code-taste@0.3.0",
  "license": "MIT",
  "keywords": ["taste", "coding-style", "conventions"],
  "official": false
}
```

Check the target index's own README for the exact schema before opening the PR — the
field names above match the common format but each maintainer validates slightly
differently.

## 3. Releases

```sh
node test/harness.mjs            # must pass first
npm version patch                # 0.10.1 -> 0.10.2, commits and tags
git push github main --follow-tags
npm publish --access public      # 2FA prompt, then a 1-2 minute processing window
```

`npm version patch|minor|major` bumps `package.json`, makes the release commit and creates the tag
in one step, so tag and version cannot drift apart. Use `npm version 0.11.0-rc.1` for a pre-release,
then `npm publish --tag next` so `latest` keeps pointing at the stable release.

Publish from a clean tree, after the push: if a publish is rejected you can fix the working copy and
re-run `npm publish` for the same version, but a version that already reached the registry can never
be reused — that is what a patch bump is for.

Keep the git tag and the npm version identical; the index entries carry the version, and
users upgrade with `dsh plugin add dsh-code-taste@0.10.2`.

## 4. Before every release

- [ ] `node test/harness.mjs` passes
- [ ] `npm pack --dry-run` contains `index.js`, `lib/*.js`, `cordis.patch.yml`, `locale/*`, `icon.svg`, both READMEs, `LICENSE`
- [ ] `README.md` (Chinese) and `README.en.md` describe the current version
- [ ] the banner URL still resolves (`https://baxterl.github.io/assets/dsh-code-taste/banner.png`)
- [ ] `taste config` shows the default `model.source`

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | Account has no 2FA and the token does not bypass it | Enable 2FA (`auth-and-writes`) and publish interactively |
| `E409 Cannot publish over previously staged version` | The previous publish of this version is still processing, or that version is genuinely live | Wait a minute and re-check `npm view`; otherwise bump the version |
| `npm view` still shows the old version right after publishing | Async processing window | Wait 1-2 minutes |
| `latest` is `0.0.0-stage` | Only the placeholder exists — the real version never landed | Publish again, or approve the staged version on npmjs.com |
| Publishing went to a mirror | `publishConfig.registry` was removed | Restore it; the global registry on that machine may be npmmirror |
