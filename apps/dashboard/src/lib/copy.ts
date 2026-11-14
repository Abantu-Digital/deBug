/** Copy text: the Clipboard API, or a hidden textarea where that's blocked (embedded browsers, plain http). */
export async function copyText(text: string, doc: Document = document, nav: Navigator = navigator): Promise<boolean> {
  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    try {
      return doc.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
