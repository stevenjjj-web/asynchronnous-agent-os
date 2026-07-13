const EYE_FRAMES = [
  ['◉', '◉'],
  ['◉', '◉'],
  ['◕', '◕'],
  ['—', '—'],
  ['◉', '◉'],
  ['◉', '◉'],
  ['◔', '◔'],
  ['◉', '◉'],
];

function wideOwl(phase) {
  const [leftEye, rightEye] = EYE_FRAMES[phase % EYE_FRAMES.length];
  const sparkle = phase % 4 === 0 ? '✦' : phase % 4 === 2 ? '·' : ' ';
  const wings = phase % 2 === 0
    ? '   /  /\\  /|     |\\  /\\  \\'
    : '   \\  \\/  \\|     |/  \\/  /';
  return [
    `             ${sparkle}`,
    '          .-"""""-.',
    `        .'   ${leftEye}  ${rightEye}   '.`,
    '       /       ▲       \\',
    '      |     \\ ___ /     |',
    "       \\     '---'     /",
    "    .---'-._______.-'---.",
    wings,
    '  /__/   \\/ |_____| \\/   \\__\\',
    '             ^^   ^^',
  ];
}

function compactOwl(phase) {
  const [leftEye, rightEye] = EYE_FRAMES[phase % EYE_FRAMES.length];
  return [
    '       .-"""-.',
    `      / ${leftEye}   ${rightEye} \\`,
    '     |    ▲    |',
    "      \\  '-'  /",
    '     /|_____|\\',
    '       ^^ ^^',
  ];
}

export function owlArt({ phase = 0, compact = false } = {}) {
  return compact ? compactOwl(phase) : wideOwl(phase);
}

export const MASCOT_NAME = 'Kernel Owl';
export const MASCOT_TAGLINE = 'awake while your work is waiting';
