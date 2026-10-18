export type LayoutNode = { id: string; x: number; y: number; width: number; height: number }
export type Point2 = { x: number; y: number }

// Tidies the type graph without rearranging it: nodes are grouped into rows by their current vertical position, kept in
// their left-to-right order, snapped to an even grid (so columns line up across rows), and empty rows and columns are
// closed up. The layout's top-left corner stays where it was.
export function tidyLayout(nodes: LayoutNode[], gapX = 90, gapY = 110): Record<string, Point2> {
  if (!nodes.length) return {}
  const originX = Math.min(...nodes.map(n => n.x)), originY = Math.min(...nodes.map(n => n.y))
  const pitchX = Math.max(...nodes.map(n => n.width)) + gapX
  const centre = (n: LayoutNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 })
  // Rows: a node joins the current row while its centre is within half a node height of the row's average centre.
  const rows: LayoutNode[][] = []
  for (const node of [...nodes].sort((a, b) => centre(a).y - centre(b).y || centre(a).x - centre(b).x)) {
    const row = rows.at(-1)
    const rowCentre = row ? row.reduce((sum, n) => sum + centre(n).y, 0) / row.length : 0
    const limit = row ? Math.max(...row.map(n => n.height), node.height) / 2 : 0
    if (row && centre(node).y - rowCentre <= limit) row.push(node)
    else rows.push([node])
  }
  // Columns: the nearest grid column to each node's current position; collisions in a row move right in order.
  const minCentreX = Math.min(...nodes.map(n => centre(n).x))
  const placed = rows.map(row => {
    let next = -Infinity
    return [...row].sort((a, b) => centre(a).x - centre(b).x).map(node => {
      const column = Math.max(Math.round((centre(node).x - minCentreX) / pitchX), next)
      next = column + 1
      return { node, column }
    })
  })
  const used = [...new Set(placed.flat().map(p => p.column))].sort((a, b) => a - b)
  const compact = new Map(used.map((column, index) => [column, index]))
  const result: Record<string, Point2> = {}
  let top = originY
  for (const row of placed) {
    for (const { node, column } of row) result[node.id] = { x: Math.round(originX + compact.get(column)! * pitchX), y: Math.round(top) }
    top += Math.max(...row.map(p => p.node.height)) + gapY
  }
  return result
}
