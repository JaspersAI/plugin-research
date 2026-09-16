# plugin-research

Research rooms for [Jaspers Terminal](https://github.com/JaspersAI), an open source, extensible desktop terminal for financial research.

A room is a thread and a roster of analysts. Ask the assistant for a room on a company and talk to it: the analysts research in parallel over the connections' tools, read what the other views on your workspace show when you point at one, and answer with citations checked against the filings. Analysts are Markdown files: eight presets here, and your own in `~/Jaspers/research/analysts`, which replace a preset by id.

## Install

In Jaspers Terminal, open Settings > Plugins, paste

```
https://github.com/JaspersAI/plugin-research
```

and press Install. The app downloads the latest release, shows where it came from, and asks before any of it runs. A plugin runs code on your computer with your permissions, so install plugins only from people you trust.

## Keys

- **Jaspers API key**, from your Jaspers account.

The app asks for it the first time an analyst needs it, or take it in Settings > Plugins. It is sealed in your OS keychain and never reaches the plugin or the assistant.

## Needs

Nothing else.

## Develop

```sh
git clone https://github.com/JaspersAI/plugin-research.git ~/Jaspers/plugins/research
cd ~/Jaspers/plugins/research
npm install
npm run typecheck
npm test
```

A folder you put in `~/Jaspers/plugins` is a plugin of your own, which the app rebuilds whenever you save. If this plugin is installed, remove it in Settings > Plugins first: the clone goes where the installed copy lives. Types come from [`@jaspers-ai/sdk`](https://www.npmjs.com/package/@jaspers-ai/sdk), which the app provides at run time.

## Release

Bump `version` in `package.json`, commit, and push a tag:

```sh
npm version patch
git push --follow-tags
```

The Release workflow checks the plugin and attaches `research-<version>.zip` to a GitHub release. Update in Settings > Plugins picks it up.

## License

[MIT](LICENSE)
