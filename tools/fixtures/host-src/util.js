// tools/fixtures/host-src/util.js —— 探针桩
export function escapeCqText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;');
}

export default { escapeCqText };
