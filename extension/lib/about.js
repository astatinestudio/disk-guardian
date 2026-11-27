// Project facts shown in the app's About page (shared with the desktop app, see
// desktop/scripts/sync-shared.mjs). Bump UPDATED with every release.

export const ABOUT = {
    name: 'Disk Guardian',
    author: 'Reza Ardi',
    created: '2026-11-15',
    updated: '2026-11-27',
    repo: 'https://github.com/astatinestudio/disk-guardian',
};

export const ABOUT_DESCRIPTION =
    'Keeps an eye on the health and temperature of every disk: SMART data, power-on hours, alerts and history, on Windows, macOS and Linux. Free and open source.';

/** "2026-11-15" as a long date in the UI language (Persian: solar calendar). */
export function aboutDate(iso, tag) {
    const d = new Date(`${iso}T12:00:00Z`);
    try {
        return new Intl.DateTimeFormat(tag, {dateStyle: 'long', timeZone: 'UTC'}).format(d);
    } catch {
        return iso;
    }
}
