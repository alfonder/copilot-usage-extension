import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    parseJsonc, pickAccount, keyringUsernames, apiBaseForHost, hostname,
    normalizeUsage, formatNumber, formatDuration,
} from './usage.js';

const KEYRING_SERVICE = 'copilot-cli';
const USER_AGENT = 'GitHubCopilotChat/0.26.7';
const EDITOR_VERSION = 'vscode/1.99.0';
const DEFAULT_HOST = 'https://github.com';

class UsageError extends Error {
    constructor(short, detail) {
        super(detail);
        this.short = short;
    }
}

function runCommand(argv, cancellable) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    resolve(p.get_successful() && out ? out.trim() : null);
                } catch (e) {
                    resolve(null);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function readCopilotConfig(cancellable) {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.copilot', 'config.json']);
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                const [, contents] = file.load_contents_finish(res);
                resolve(parseJsonc(new TextDecoder('utf-8').decode(contents)));
            } catch (e) {
                resolve(null);
            }
        });
    });
}

const CopilotUsageIndicator = GObject.registerClass(
class CopilotUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Copilot Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._cancellable = new Gio.Cancellable();
        this._session = this._createSession();
        this._lastData = null;
        this._refreshing = false;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'copilot-symbolic.svg']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'copilot-icon system-status-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'copilot-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'copilot-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'copilot-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        this._icon.visible = this._settings.get_boolean('show-icon');
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session)
            this._session.abort();
        this._session = this._createSession();
        this._refreshUsage();
    }

    _createLabelItem(styleClass) {
        const label = new St.Label({text: '', style_class: styleClass});
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(label);
        this.menu.addMenuItem(item);
        return {item, label};
    }

    _createMenu() {
        const plan = this._createLabelItem('copilot-section-title');
        this._planItem = plan.item;
        this._planLabel = plan.label;
        this._planLabel.set_text('GitHub Copilot');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const box = new St.BoxLayout({style_class: 'copilot-usage-section', vertical: true});
        const header = new St.BoxLayout({vertical: false});
        this._titleLabel = new St.Label({
            text: 'Monthly AI credits',
            style_class: 'copilot-section-title',
        });
        header.add_child(this._titleLabel);
        this._percentLabel = new St.Label({
            text: '...',
            style_class: 'copilot-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(this._percentLabel);
        box.add_child(header);

        const progressBg = new St.Widget({style_class: 'copilot-progress-bg'});
        this._progressBar = new St.Widget({style_class: 'copilot-progress-bar usage-low'});
        progressBg.add_child(this._progressBar);
        box.add_child(progressBg);

        this._detailLabel = new St.Label({text: '', style_class: 'copilot-reset-label'});
        box.add_child(this._detailLabel);
        this._resetLabel = new St.Label({text: 'Resets: ...', style_class: 'copilot-reset-label'});
        box.add_child(this._resetLabel);
        this._projectionLabel = new St.Label({text: '', style_class: 'copilot-reset-label'});
        box.add_child(this._projectionLabel);

        const usageItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        usageItem.add_child(box);
        this.menu.addMenuItem(usageItem);

        const overage = this._createLabelItem('copilot-reset-label');
        this._overageItem = overage.item;
        this._overageLabel = overage.label;
        this._overageItem.hide();

        this._othersSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._othersSeparator);
        const others = this._createLabelItem('copilot-reset-label');
        this._othersItem = others.item;
        this._othersLabel = others.label;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const updated = this._createLabelItem('copilot-last-updated-label');
        this._updatedLabel = updated.label;

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    async _refreshUsage() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        try {
            const {token, host} = await this._getCredentials();
            const raw = await this._fetchUsage(token, host);
            const usage = normalizeUsage(raw);
            if (!usage)
                throw new UsageError('Unsupported', 'No premium quota in the Copilot response');
            this._lastData = usage;
            this._updateDisplay(usage);
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            const short = e instanceof UsageError ? e.short : 'Error';
            console.error(`Copilot Usage: ${e.message}`);
            this._showError(short, e.message);
        } finally {
            this._refreshing = false;
        }
    }

    /**
     * Token lookup order: Copilot CLI keyring entry, COPILOT_GITHUB_TOKEN/GH_TOKEN/
     * GITHUB_TOKEN env vars, then `gh auth token`.
     */
    async _getCredentials() {
        const config = await readCopilotConfig(this._cancellable);
        const account = pickAccount(config);
        const host = account?.host ?? DEFAULT_HOST;

        let token = null;
        if (account) {
            for (const username of keyringUsernames(account.host, account.login)) {
                token = await runCommand(
                    ['secret-tool', 'lookup', 'service', KEYRING_SERVICE, 'username', username],
                    this._cancellable
                );
                if (token)
                    break;
            }
        }

        token ??= GLib.getenv('COPILOT_GITHUB_TOKEN') ?? GLib.getenv('GH_TOKEN') ??
            GLib.getenv('GITHUB_TOKEN');

        if (!token) {
            token = await runCommand(
                ['gh', 'auth', 'token', '--hostname', hostname(host)],
                this._cancellable
            );
        }

        if (!token) {
            throw new UsageError(
                'No token',
                'No Copilot token found. Sign in with the Copilot CLI and install secret-tool (libsecret-tools).'
            );
        }
        return {token, host};
    }

    async _fetchUsage(token, host) {
        const base = apiBaseForHost(host);
        if (!base)
            throw new UsageError('Error', `Invalid host in Copilot config: ${host}`);

        const message = Soup.Message.new('GET', `${base}/copilot_internal/user`);
        const headers = message.request_headers;
        headers.append('Authorization', `token ${token}`);
        headers.append('Accept', 'application/json');
        headers.append('User-Agent', USER_AGENT);
        headers.append('Editor-Version', EDITOR_VERSION);

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        const status = message.status_code;
        if (status === 401)
            throw new UsageError('Sign in', 'Copilot token rejected (401). Sign in again with the Copilot CLI.');
        if (status === 403 || status === 429)
            throw new UsageError('Rate limit', `Access denied or rate limited (HTTP ${status}).`);
        if (status === 404)
            throw new UsageError('No Copilot', 'No Copilot access found for this account (HTTP 404).');
        if (status !== 200)
            throw new UsageError('Error', `Unexpected response (HTTP ${status}).`);

        return JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
    }

    _showError(short, detail) {
        if (this._lastData) {
            this._updatedLabel.set_text(`Update failed: ${short}. Showing last data.`);
            return;
        }
        this._label.set_text(short);
        this._percentLabel.set_text('—');
        this._detailLabel.set_text(detail);
        this._resetLabel.set_text('');
        this._projectionLabel.set_text('');
        this._updatePanelProgressBar(0);
        this._updateProgressBar(this._progressBar, 0);
    }

    _updateDisplay(u) {
        const unit = u.unit === 'credits' ? 'credits' : 'requests';
        this._planLabel.set_text(u.plan ? `GitHub Copilot ${this._capitalize(u.plan)}` : 'GitHub Copilot');
        this._titleLabel.set_text(u.unit === 'credits' ? 'Monthly AI credits' : 'Premium requests');

        if (u.unlimited) {
            this._label.set_text('∞');
            this._percentLabel.set_text('Unlimited');
            this._detailLabel.set_text(`${formatNumber(u.used)} ${unit} used`);
            this._projectionLabel.set_text('');
            this._updatePanelProgressBar(0);
            this._updateProgressBar(this._progressBar, 0, true);
        } else {
            this._label.set_text(`${Math.round(u.percent)}%`);
            this._percentLabel.set_text(`${u.percent.toFixed(1)}%`);
            this._detailLabel.set_text(
                `${formatNumber(u.used)} / ${formatNumber(u.total)} ${unit} used · ${formatNumber(u.remaining)} left`
            );
            this._projectionLabel.set_text(
                u.projected !== null
                    ? `Projected: ~${formatNumber(u.projected)} by month end (${Math.round(u.projectedPercent)}%)`
                    : ''
            );
            this._updatePanelProgressBar(u.percent);
            this._updateProgressBar(this._progressBar, u.percent);
        }

        const resetIn = formatDuration(u.resetAt.getTime() - Date.now());
        this._resetLabel.set_text(`Resets in ${resetIn} (${u.resetAt.toISOString().slice(0, 10)} 00:00 UTC)`);

        if (u.overage > 0) {
            this._overageLabel.set_text(`Overage: ${formatNumber(u.overage)} ${unit}`);
            this._overageItem.show();
        } else {
            this._overageItem.hide();
        }

        const others = u.others.map(o => o.unlimited
            ? `${o.label}: Unlimited`
            : `${o.label}: ${formatNumber(o.used)} / ${formatNumber(o.total)}`);
        this._othersLabel.set_text(others.join('\n'));
        this._othersItem.visible = others.length > 0;
        this._othersSeparator.visible = others.length > 0;

        this._updatedLabel.set_text(`Updated ${GLib.DateTime.new_now_local().format('%H:%M')}`);
    }

    _capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    _updatePanelProgressBar(usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _updateProgressBar(progressBar, usage, unlimited = false) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        for (const cls of ['usage-low', 'usage-medium', 'usage-high', 'usage-critical', 'usage-unlimited'])
            progressBar.remove_style_class_name(cls);

        if (unlimited)
            progressBar.add_style_class_name('usage-unlimited');
        else if (usage >= 90)
            progressBar.add_style_class_name('usage-critical');
        else if (usage >= 70)
            progressBar.add_style_class_name('usage-high');
        else if (usage >= 40)
            progressBar.add_style_class_name('usage-medium');
        else
            progressBar.add_style_class_name('usage-low');
    }

    destroy() {
        this._stopTimer();
        this._cancellable?.cancel();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class CopilotUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CopilotUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
