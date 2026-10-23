# Publishing

The DeepSeek Harness ecosystem has **no official marketplace**. "Publishing to the
community market" means two separate things:

1. publish the package to npm, and
2. get an index entry into one or more community indexes.

The market tab inside DSH (Discover) only lists the indexes a user adds, so an npm
release is what actually makes the plugin installable and discoverable.

## 1. npm

```sh
npm login                      # browser flow, once per machine
npm pack --dry-run             # check the file list before publishing
npm test --if-present          # or: node test/harness.mjs
npm publish --access public
```

The package is scoped to no user, so `dsh-code-taste` must stay globally unique.
After a release, verify:

```sh
npm view dsh-code-taste version
npm view dsh-code-taste dsh
```

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
npm version patch        # 0.3.0 -> 0.3.1, commits and tags
git push github main --follow-tags
npm publish --access public
```

Keep the git tag and the npm version identical; the index entries carry the version, and
users upgrade with `dsh plugin add dsh-code-taste@0.3.1`.

## 4. Before every release

- [ ] `node test/harness.mjs` passes
- [ ] `npm pack --dry-run` contains `index.js`, `lib/*.js`, `cordis.patch.yml`, `locale/*`, `icon.svg`, both READMEs, `LICENSE`
- [ ] `README.md` and `README.zh.md` describe the current version
- [ ] the banner URL still resolves (`https://baxterl.github.io/assets/dsh-code-taste/banner.png`)
- [ ] `taste config` shows the default `mode: regex`
