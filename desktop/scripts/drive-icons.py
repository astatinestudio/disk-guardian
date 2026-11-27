# Drive-type icons drawn for Disk Guardian, in the Material Symbols Rounded "filled" style:
# 24 px grid, solid shapes, rounded corners, details as cut-outs (fill-rule evenodd).
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ui', 'icons')
HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'


def circle(cx, cy, r):
    return f'M{cx + r} {cy}a{r} {r} 0 1 0-{2 * r} 0a{r} {r} 0 1 0 {2 * r} 0z'


def rrect(x, y, w, h, r):
    return (f'M{x + r} {y}h{w - 2 * r}a{r} {r} 0 0 1 {r} {r}v{h - 2 * r}a{r} {r} 0 0 1-{r} {r}'
            f'h-{w - 2 * r}a{r} {r} 0 0 1-{r}-{r}v-{h - 2 * r}a{r} {r} 0 0 1 {r}-{r}z')


def svg(paths, extra=''):
    d = ''.join(paths)
    return f'{HEAD}<path fill-rule="evenodd" d="{d}"/>{extra}</svg>\n'


icons = {
    # hard disk: case, platter (ring), spindle, read arm, activity slot + LED
    'hdd': svg([
        rrect(3, 2.5, 18, 19, 3),
        circle(12, 10, 5.6),
        circle(12, 10, 1.7),
        rrect(6.5, 17, 5, 1.6, 0.8),
        circle(16.6, 17.8, 1),
    ], '<path d="M16.4 14.4l-2.9-2.9" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>'),
    # 2.5" SSD: case, label with lightning bolt, two flash chips
    'ssd': svg([
        rrect(2.5, 4, 19, 16, 2.6),
        rrect(5.5, 7, 8.5, 10, 1.2),
        'M10.9 8.4L7.9 12.6h2l-.7 3 3.2-4.3h-2z',
        rrect(15.5, 7, 3, 4.2, 0.8),
        rrect(15.5, 12.8, 3, 4.2, 0.8),
    ]),
    # M.2 NVMe stick: gold fingers, two chips, screw notch on the right end
    'nvme': svg([
        'M3.5 6.5h17A1.5 1.5 0 0 1 22 8v2.4a1.6 1.6 0 0 0 0 3.2V16a1.5 1.5 0 0 1-1.5 1.5H6.4v-2.6H5v2.6H3.5A1.5 1.5 0 0 1 2 16V8a1.5 1.5 0 0 1 1.5-1.5z',
        rrect(3.4, 8.2, 0.8, 4.6, 0.4),
        rrect(5.2, 8.2, 0.8, 4.6, 0.4),
        rrect(8, 8.6, 4.4, 6.8, 0.9),
        rrect(13.8, 8.6, 4.4, 6.8, 0.9),
    ]),
    # SAS / enterprise: two rack drive sleds with status LED and handle slot
    'sas': svg([
        rrect(2.5, 3, 19, 8.2, 2.2),
        circle(6.6, 7.1, 1.3),
        rrect(10, 6.3, 8, 1.6, 0.8),
        rrect(2.5, 12.8, 19, 8.2, 2.2),
        circle(6.6, 16.9, 1.3),
        rrect(10, 16.1, 8, 1.6, 0.8),
    ]),
    # USB flash drive: plug with two contacts, body with key-ring slot
    'flash': svg([
        'M9.2 2h5.6A1.2 1.2 0 0 1 16 3.2V9H8V3.2A1.2 1.2 0 0 1 9.2 2z',
        rrect(9.8, 4.4, 1.5, 1.8, 0.3),
        rrect(12.7, 4.4, 1.5, 1.8, 0.3),
        'M7.2 9h9.6A1.2 1.2 0 0 1 18 10.2V19a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-8.8A1.2 1.2 0 0 1 7.2 9z',
        rrect(10.2, 17.2, 3.6, 1.6, 0.8),
    ]),
}
for name, text in icons.items():
    open(os.path.join(OUT, f'{name}.svg'), 'w', encoding='utf-8', newline='\n').write(text)

print('drive icons written')
