export const typeColorSwatches = [
  '#ffffff', '#d9e1e3', '#9aadb2', '#60747d', '#263943', '#000000',
  '#e85d5d', '#f28c5b', '#e6b95d', '#a8c966', '#56bb87', '#54b9c2',
  '#65b9d4', '#638ee7', '#8678dc', '#c987f0', '#d58a9b', '#ee81bb',
]

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const sector = hue / 60
  const second = chroma * (1 - Math.abs(sector % 2 - 1))
  const [r, g, b] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
      : sector < 3 ? [0, chroma, second]
        : sector < 4 ? [0, second, chroma]
          : sector < 5 ? [second, 0, chroma] : [chroma, 0, second]
  const offset = lightness - chroma / 2
  return `#${[r, g, b].map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`
}

export function nextTypeColor(existingColors: string[]): string {
  const used = new Set(existingColors.map(color => color.toLowerCase()))
  const unusedPreset = typeColorSwatches.slice(6).find(color => !used.has(color))
  if (unusedPreset) return unusedPreset
  for (let index = 0; ; index++) {
    const color = hslToHex((index * 137.508 + 11) % 360, .68, .62)
    if (!used.has(color)) return color
  }
}
