// Assign separate columns to overlapping timed records without obscuring them.
export function layoutSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || b.end - a.end || a.item.id.localeCompare(b.item.id));
  const result = [];
  let group = [];
  let lanes = [];
  let groupEnd = -1;
  function flush() {
    for (const segment of group) result.push({ ...segment, columns: lanes.length });
    group = []; lanes = [];
  }
  for (const segment of sorted) {
    if (group.length && segment.start >= groupEnd) flush();
    let lane = lanes.findIndex(end => end <= segment.start);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = segment.end;
    group.push({ ...segment, lane });
    groupEnd = Math.max(...lanes);
  }
  flush();
  return result;
}
