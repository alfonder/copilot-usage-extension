# GitHub Copilot usage extension
![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)

A GNOME Shell extension that shows your GitHub Copilot usage in the top panel: how much of your monthly allowance you have used, and when it resets.

> This extension is not affiliated with, funded by, or associated with GitHub or Microsoft.

## Features

- **Monthly usage** - AI credits used, total, remaining and percentage (or premium requests on request-based plans)
- **Reset countdown** - Copilot allowances reset at 00:00 UTC on the 1st of each month
- **Pace projection** - estimated usage at the end of the month, based on your usage so far
- **Overage and unlimited quotas** - overage is shown when present; unlimited quotas show `∞`. Chat and completions are listed with their own status
- **Plan name** - for example *GitHub Copilot Business*
- **GitHub Enterprise Cloud (`*.ghe.com`) support** - the API host is derived from your Copilot CLI login
- **Settings** - panel layout (text, bar or both), refresh interval, icon visibility and proxy

## Requirements

- GNOME Shell 46 or later (the version list in `metadata.json` is 46-49; not every version has been tested)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) installed and signed in. The extension reads the account from `~/.copilot/config.json`
- `secret-tool`, to read the Copilot CLI token from your system keyring. It is not installed by default:
  - Debian/Ubuntu: `sudo apt install libsecret-tools`
  - Fedora: `sudo dnf install libsecret`
  - Arch: `sudo pacman -S libsecret`

If no keyring entry is found, the extension falls back to the `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` environment variables (only visible if they are set for the GNOME Shell session), and then to `gh auth token`.

## Privacy and network access

- The token is read from your keyring at every refresh. It is never written to disk or to GSettings.
- The token is sent only to the GitHub API host of your account: `api.github.com`, or `api.<tenant>.ghe.com` for GitHub Enterprise Cloud. The extension calls `GET /copilot_internal/user`.
- That endpoint is an internal, undocumented GitHub API, the same one the Copilot clients use. It can change without notice, and the extension may stop working if it does.
- The request sends editor-style headers (`User-Agent`, `Editor-Version`) that the endpoint expects.
- Nothing else is sent anywhere. There is no telemetry.

## Installation

### Manual

```bash
git clone https://github.com/alfonder/copilot-usage-extension
cd copilot-usage-extension
./update              # copies the extension to ~/.local/share/gnome-shell/extensions/ and compiles the schema
```

`./update` needs `rsync`. Then restart GNOME Shell (log out and back in on Wayland, or press `Alt+F2`, type `r` on X11), and enable the extension:

```bash
gnome-extensions enable copilot-usage@alfonder
```

`./update --logout` logs you out immediately after installing.

## Development

```bash
gjs -m tests/usage-test.js    # unit tests for the parsing logic
```

The data and parsing logic lives in `usage.js`, which has no GNOME dependencies. UI code is in `extension.js`, settings in `prefs.js`.

## Limitations

- The Copilot CLI config file is parsed as JSONC (comments are allowed). Only the account name and host are read from it. The token comes from the keyring.
- Business and Enterprise allowances may be pooled at organisation level. The extension shows the per-seat figures that the API reports.
- Free plans and other layouts without a `premium_interactions` quota show "Unsupported".

## License

MIT, see [LICENSE](LICENSE).
