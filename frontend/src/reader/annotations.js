const coordinateScale = 10000;
const maxRectangles = 2000;

export function selectionRectangles(range, pageBounds) {
  if (!pageBounds.width || !pageBounds.height) return [];
  const relative = (value, origin, size) => Math.round(
    Math.min(1, Math.max(0, (value - origin) / size)) * coordinateScale
  );
  const document = range.startContainer.ownerDocument;
  const bounds = range.commonAncestorContainer;
  const textNodes = document.createTreeWalker(bounds, 4); // NodeFilter.SHOW_TEXT
  const textRange = document.createRange();
  const rectangles = new Set();
  let node = bounds.nodeType === 3 ? bounds : textNodes.nextNode();
  while (node && rectangles.size <= maxRectangles) {
    if (range.intersectsNode(node)) {
      textRange.setStart(node, node === range.startContainer ? range.startOffset : 0);
      textRange.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
      // Measure text only. A multi-line DOM range can also contain whole span boxes.
      for (const rect of textRange.getClientRects()) {
        const left = relative(rect.left, pageBounds.left, pageBounds.width);
        const top = relative(rect.top, pageBounds.top, pageBounds.height);
        const right = relative(rect.right, pageBounds.left, pageBounds.width);
        const bottom = relative(rect.bottom, pageBounds.top, pageBounds.height);
        if (right > left && bottom > top) rectangles.add(`${left},${top},${right},${bottom}`);
      }
    }
    node = textNodes.nextNode();
  }
  return rectangles.size <= maxRectangles ? [...rectangles] : [];
}

export function parseSelection(value) {
  const parts = value.split('.');
  if (parts.length > maxRectangles) return null;
  const rectangles = [];
  for (const part of parts) {
    if (!/^\d{1,5}(?:,\d{1,5}){3}$/.test(part)) return null;
    const [left, top, right, bottom] = part.split(',').map(Number);
    if (left >= right || top >= bottom || right > coordinateScale || bottom > coordinateScale) return null;
    rectangles.push([left, top, right, bottom].map(value => value / coordinateScale));
  }
  return rectangles;
}

export function annotationQuote(text) {
  return text.split(/\r\n?|\n/).map(line => {
    const literal = line.replace(/[\\`*_{}\[\]<>()#+\-.!|~=&]/g, '\\$&');
    return `> ${literal}`;
  }).join('\n');
}
