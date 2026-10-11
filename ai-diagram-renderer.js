const SVG_NS = "http://www.w3.org/2000/svg";
const allowedKinds = new Set(["line", "arrow", "ray", "mirror", "circle", "dot", "text"]);

export function renderDiagram(spec, container) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 800 500");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "AI-generated study diagram");
  svg.classList.add("ai-study-diagram");
  for (const object of (Array.isArray(spec?.objects) ? spec.objects : []).slice(0, 100)) {
    if (!object || !allowedKinds.has(object.kind)) continue;
    const line = ["line", "arrow", "ray", "mirror"].includes(object.kind);
    const el = document.createElementNS(SVG_NS, line ? "line" : object.kind === "text" ? "text" : "circle");
    const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(-100, Math.min(900, Number(v))) : fallback;
    if (line) {
      el.setAttribute("x1", num(object.x)); el.setAttribute("y1", num(object.y));
      el.setAttribute("x2", num(object.x2)); el.setAttribute("y2", num(object.y2));
      el.setAttribute("stroke-width", object.kind === "mirror" ? "5" : "2");
      if (object.kind === "ray") el.setAttribute("stroke-dasharray", "6 5");
      if (object.kind === "arrow") el.setAttribute("marker-end", "url(#ai-arrow)");
    } else if (object.kind === "text") {
      el.setAttribute("x", num(object.x)); el.setAttribute("y", num(object.y));
      el.setAttribute("font-size", "16"); el.textContent = String(object.label || "").slice(0, 100);
    } else {
      el.setAttribute("cx", num(object.x)); el.setAttribute("cy", num(object.y));
      el.setAttribute("r", object.kind === "dot" ? 5 : Math.max(3, Math.min(80, num(object.radius, 12))));
      el.setAttribute("fill", object.kind === "circle" ? "none" : (object.color || "#287d76"));
    }
    el.setAttribute("stroke", /^#[0-9a-f]{6}$/iu.test(object.color || "") ? object.color : "#263e42");
    svg.append(el);
  }
  container.replaceChildren(svg);
  return svg;
}
