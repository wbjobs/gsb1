function elementOffset(node, offset) {
  let result = 0;
  for (let i = 0; i < offset; i += 1) {
    const child = node.childNodes[i];
    result += child.nodeType === Node.TEXT_NODE ? child.textContent.length : 1;
  }
  return result;
}

export function domPositionToOffset(editor, container, offset) {
  let current = container;
  let localOffset = offset;
  while (current && current !== editor && current.parentElement !== editor) {
    const parent = current.parentElement;
    localOffset += elementOffset(parent, Array.from(parent.childNodes).indexOf(current));
    current = parent;
  }
  if (!current || current === editor) return 0;

  const paragraphIndex = Array.from(editor.children).indexOf(current);
  const prefix = Array.from(editor.children)
    .slice(0, paragraphIndex)
    .reduce((sum, paragraph) => sum + paragraph.textContent.length + 1, 0);
  return prefix + Math.min(localOffset, current.textContent.length);
}

function rangeForOffset(editor, targetOffset) {
  const range = document.createRange();
  let remaining = targetOffset;
  const paragraphs = Array.from(editor.children);

  for (let p = 0; p < paragraphs.length; p += 1) {
    const paragraph = paragraphs[p];
    const length = paragraph.textContent.length;
    if (remaining <= length) {
      let walked = 0;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        const nodeLength = textNode.textContent.length;
        if (remaining <= walked + nodeLength) {
          range.setStart(textNode, remaining - walked);
          range.collapse(true);
          return range;
        }
        walked += nodeLength;
        textNode = walker.nextNode();
      }
      range.selectNodeContents(paragraph);
      range.collapse(false);
      return range;
    }
    remaining -= length + 1;
  }

  const last = paragraphs[paragraphs.length - 1];
  range.selectNodeContents(last);
  range.collapse(false);
  return range;
}

export function getEditorOffsets(editor) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return {
    start: domPositionToOffset(editor, range.startContainer, range.startOffset),
    end: domPositionToOffset(editor, range.endContainer, range.endOffset),
  };
}

export function setEditorOffsets(editor, startOffset, endOffset = startOffset) {
  if (!editor.childElementCount) return;
  const selection = window.getSelection();
  if (!selection) return;
  const startRange = rangeForOffset(editor, Math.max(0, startOffset));
  selection.removeAllRanges();
  if (endOffset === startOffset) {
    selection.addRange(startRange);
    return;
  }
  const endRange = rangeForOffset(editor, Math.max(startOffset, endOffset));
  const range = document.createRange();
  range.setStart(startRange.startContainer, startRange.startOffset);
  range.setEnd(endRange.startContainer, endRange.startOffset);
  selection.removeAllRanges();
  selection.addRange(range);
}
