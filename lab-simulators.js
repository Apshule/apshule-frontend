const WIDTH = 800;
const HEIGHT = 500;
const PALETTE = {
  ink: "#243b43",
  muted: "#70878b",
  teal: "#287d76",
  lime: "#d3e2a5",
  coral: "#dc765f",
  gold: "#e6b85d",
  sky: "#d9edf0",
  paper: "#f7f7ef",
  soil: "#79594c",
  blue: "#5d9cac",
  red: "#c86b5d",
};

function roundedRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function line(ctx, x1, y1, x2, y2, color, width = 2, dash = []) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function circle(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

let activeCanvasText = (text) => text;
function label(ctx, text, x, y, size = 15, color = PALETTE.ink, weight = 500) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "DM Sans", sans-serif`;
  ctx.fillText(activeCanvasText(String(text)), x, y);
}

function canvasTextKey(type, text) {
  const dynamicPatterns = [
    [/^(Light|Water|Sunlight) ([\d.]+)%$/, (match) => [`${match[1].toLowerCase()}_percent`, { value: match[2] }]],
    [/^CO₂ ([\d.]+)%$/, (match) => ["carbon_dioxide_percent", { value: match[1] }]],
    [/^Frequency ([\d.]+) Hz$/, (match) => ["frequency_hz", { value: match[1] }]],
    [/^Amplitude ([\d.]+) units$/, (match) => ["amplitude_units", { value: match[1] }]],
    [/^pH ([\d.]+)$/, (match) => ["ph_value", { value: match[1] }]],
    [/^([\d.]+) mL added$/, (match) => ["base_volume_ml", { value: match[1] }]],
    [/^([\d.]+) kg$/, (match) => ["mass_kg", { value: match[1] }]],
    [/^([\d.]+)°C$/, (match) => ["temperature_celsius", { value: match[1] }]],
    [/^Concentration ([\d.]+)%$/, (match) => ["concentration_percent", { value: match[1] }]],
    [/^Parent A: ([A-Za-z]+)$/, (match) => ["parent_a_genotype", { genotype: match[1] }]],
    [/^Parent B: ([A-Za-z]+)$/, (match) => ["parent_b_genotype", { genotype: match[1] }]],
    [/^([\d.]+) oxygen bubbles \/ cycle$/, (match) => ["oxygen_bubbles_per_cycle", { value: match[1] }]],
    [/^([\d.]+) m\/s · ([\d.]+)°$/, (match) => ["projectile_launch_values", { velocity: match[1], angle: match[2] }]],
  ];
  for (const [pattern, build] of dynamicPatterns) {
    const match = text.match(pattern);
    if (match) {
      const [key, vars] = build(match);
      return [`canvas_${type}_${key}`, vars];
    }
  }
  const suffix = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return [`canvas_${type}_${suffix || "label"}`, {}];
}

export class LabSimulator {
  constructor(canvas, controlsEl, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.controlsEl = controlsEl;
    this.options = options;
    this.type = options.type || "plant_growth";
    this.time = 0;
    this.running = false;
    this.completed = false;
    this.frame = 0;
    this.raf = 0;
    this.interactions = 0;
    this.params = {};
    this.text = (key, fallback, vars) => options.t?.(key, fallback, vars) || fallback;
    this.destroyed = false;
    this.pointer = { x: 0, y: 0, down: false };
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.boundPointerDown = (event) => this.onPointerDown(event);
    this.boundPointerMove = (event) => this.onPointerMove(event);
    this.boundPointerUp = (event) => this.onPointerUp(event);
    canvas.addEventListener("pointerdown", this.boundPointerDown);
    canvas.addEventListener("pointermove", this.boundPointerMove);
    canvas.addEventListener("pointerup", this.boundPointerUp);
    canvas.addEventListener("pointercancel", this.boundPointerUp);
  }

  init() {
    this.render();
    return this;
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
  }

  onPointerDown(event) {
    this.pointer = { ...this.localPoint(event), down: true };
    if (this.type === "magnet_field" && this.pointer.y > 205 && this.pointer.y < 315) {
      const first = this.params.magnetX ?? 295;
      const second = this.params.secondMagnetX ?? 495;
      this.params.dragMagnet = Math.abs(this.pointer.x - first) <= Math.abs(this.pointer.x - second) ? "first" : "second";
    }
    if (this.type === "lever_balance") {
      const left = 400 + (this.params.leftPosition ?? -140);
      const right = 400 + (this.params.rightPosition ?? 140);
      if (Math.hypot(this.pointer.x - left, this.pointer.y - 295) < 40) this.params.dragMass = "left";
      else if (Math.hypot(this.pointer.x - right, this.pointer.y - 295) < 40) this.params.dragMass = "right";
    }
    this.canvas.setPointerCapture?.(event.pointerId);
    this.interactions += 1;
    this.render();
  }

  onPointerMove(event) {
    if (!this.pointer.down) return;
    Object.assign(this.pointer, this.localPoint(event));
    if (this.type === "lever_balance" && this.params.dragMass) {
      const side = this.params.dragMass;
      const position = this.pointer.x - 400;
      this.params[side === "left" ? "leftPosition" : "rightPosition"] = side === "left"
        ? Math.max(-285, Math.min(-45, position))
        : Math.max(45, Math.min(285, position));
    }
    this.render();
  }

  onPointerUp() {
    this.pointer.down = false;
    delete this.params.dragMagnet;
    delete this.params.dragMass;
  }

  onControl(name, value) {
    this.params[name] = value;
    this.interactions += 1;
    this.render();
  }

  run() {
    if (this.destroyed) return;
    this.running = true;
    this.completed = false;
    this.runStarted = performance.now();
    cancelAnimationFrame(this.raf);
    const tick = (now) => {
      if (!this.running || this.destroyed) return;
      this.time = (now - this.runStarted) / 1000;
      this.render();
      if (this.time >= 4.4) {
        this.running = false;
        this.completed = true;
        this.options.onComplete?.(this.getScore());
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  reset() {
    this.running = false;
    this.completed = false;
    this.time = 0;
    this.interactions = 0;
    this.params = {};
    cancelAnimationFrame(this.raf);
    this.render();
  }

  getScore() {
    const precision = this.type === "circuit_builder"
      ? (this.isCircuitClosed() ? 1 : 0)
      : this.interactions > 0 ? 1 : 0;
    const controlCredit = Math.min(45, this.interactions * 9);
    return Math.max(35, Math.min(100, 48 + controlCredit + (precision ? 7 : 0)));
  }

  drawBase(title, subtitle) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = PALETTE.paper;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "#edf1e7";
    ctx.fillRect(0, 0, WIDTH, 64);
    label(ctx, title, 28, 32, 17, PALETTE.ink, 700);
    label(ctx, subtitle, 28, 52, 11, PALETTE.muted, 500);
    roundedRect(ctx, 665, 27, 92, 5, 3, "#dce5d7");
    if (this.running) roundedRect(ctx, 665, 27, 92 * Math.min(1, this.time / 4.4), 5, 3, PALETTE.teal);
    line(ctx, 0, 64, WIDTH, 64, "#e1e6d9", 1);
  }

  render() {
    if (!this.ctx || this.destroyed) return;
    const renderers = {
      plant_growth: () => this.renderPlant(),
      water_cycle: () => this.renderWater(),
      magnet_field: () => this.renderMagnet(),
      wave_generator: () => this.renderWave(),
      circuit_builder: () => this.renderCircuit(),
      titration: () => this.renderTitration(),
      lever_balance: () => this.renderLever(),
      photosynthesis_sim: () => this.renderPhotosynthesis(),
      projectile: () => this.renderProjectile(),
      reaction_rate: () => this.renderReaction(),
      genetics_cross: () => this.renderGenetics(),
      electric_field: () => this.renderElectricField(),
    };
    const previousText = activeCanvasText;
    activeCanvasText = (text) => {
      const [key, vars] = canvasTextKey(this.type, text);
      return this.text(key, text, vars);
    };
    try {
      (renderers[this.type] || renderers.plant_growth)();
    } finally {
      activeCanvasText = previousText;
    }
  }

  renderPlant() {
    const ctx = this.ctx;
    this.drawBase("Plant growth", "Observe how light and water change a seedling");
    const sunlight = Number(this.params.light ?? 60) / 100;
    const water = Number(this.params.water ?? 55) / 100;
    const growth = this.running ? Math.min(1, this.time / 4.4) : 0.62;
    const h = 110 + growth * (80 + sunlight * 65 + water * 30);
    roundedRect(ctx, 500, 125, 210, 255, 22, "#e8eee0");
    circle(ctx, 650, 172, 34, PALETTE.gold);
    line(ctx, 0, 407, WIDTH, 407, "#a1b887", 3);
    roundedRect(ctx, 334, 407, 132, 53, 10, PALETTE.soil);
    line(ctx, 400, 405, 400, 405 - h, PALETTE.teal, 9);
    line(ctx, 400, 350 - h / 2, 353, 328 - h / 2, PALETTE.teal, 6);
    line(ctx, 400, 330 - h / 2, 446, 305 - h / 2, PALETTE.teal, 6);
    circle(ctx, 350, 327 - h / 2, 17, "#8ead69");
    circle(ctx, 449, 303 - h / 2, 18, "#9ab777");
    if (this.running && Math.floor(this.time * 5) % 2 === 0) {
      circle(ctx, 374, 380 - growth * 20, 4, PALETTE.blue);
      circle(ctx, 426, 364 - growth * 20, 4, PALETTE.blue);
    }
    label(ctx, `Light ${Math.round(sunlight * 100)}%`, 112, 174, 13, PALETTE.muted);
    label(ctx, `Water ${Math.round(water * 100)}%`, 112, 199, 13, PALETTE.muted);
  }

  renderWater() {
    const ctx = this.ctx;
    this.drawBase("The water cycle", "Follow evaporation, condensation and precipitation");
    const heat = Number(this.params.heat ?? 65);
    circle(ctx, 650, 145, 25 + heat * 0.2, PALETTE.gold);
    roundedRect(ctx, 0, 378, WIDTH, 122, 0, "#b8dce1");
    for (let i = 0; i < 3; i += 1) circle(ctx, 180 + i * 25, 265, 31, "#fffefa");
    for (let i = 0; i < 3; i += 1) circle(ctx, 520 + i * 26, 215, 30, "#fffefa");
    label(ctx, "evaporation", 82, 348, 13, PALETTE.teal, 700);
    label(ctx, "condensation", 450, 176, 13, PALETTE.teal, 700);
    label(ctx, "precipitation", 575, 304, 13, PALETTE.teal, 700);
    line(ctx, 150, 364, 170, 300, PALETTE.blue, 2, [5, 7]);
    line(ctx, 250, 242, 390, 202, PALETTE.blue, 2, [5, 7]);
    for (let i = 0; i < Math.max(2, Math.round(heat / 12)); i += 1) {
      const y = this.running ? 290 + ((this.time * 90 + i * 31) % 90) : 310 + i * 9;
      line(ctx, 585 + i * 22, y, 578 + i * 22, y + 17, PALETTE.blue, 3);
    }
    label(ctx, `Sunlight ${heat}%`, 590, 205, 12, PALETTE.muted);
    label(ctx, this.running ? "Cycle in motion" : "Press Run to begin the cycle", 28, 460, 13, PALETTE.ink);
  }

  renderMagnet() {
    const ctx = this.ctx;
    this.drawBase("Magnetic poles", "Drag a magnet to explore attraction and repulsion");
    const x1 = this.params.magnetX ?? 295;
    const x2 = this.params.secondMagnetX ?? 495;
    for (let i = -2; i <= 2; i += 1) {
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, 270, 90 + Math.abs(i) * 23, 50 + Math.abs(i) * 13, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "#cbdcd8";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    roundedRect(ctx, x1 - 70, 225, 140, 68, 12, PALETTE.blue);
    roundedRect(ctx, x1, 225, 70, 68, 12, PALETTE.red);
    roundedRect(ctx, x2 - 70, 225, 140, 68, 12, PALETTE.blue);
    roundedRect(ctx, x2, 225, 70, 68, 12, PALETTE.red);
    label(ctx, "N", x1 - 9, 267, 22, "#fffefa", 700);
    label(ctx, "S", x1 + 28, 267, 22, "#fffefa", 700);
    label(ctx, "N", x2 - 9, 267, 22, "#fffefa", 700);
    label(ctx, "S", x2 + 28, 267, 22, "#fffefa", 700);
    label(ctx, "Like poles push apart; opposite poles pull together.", 190, 360, 15, PALETTE.ink);
    if (this.pointer.down && this.pointer.y > 210 && this.pointer.y < 310) {
      const target = this.params.dragMagnet === "second" ? "secondMagnetX" : "magnetX";
      this.params[target] = Math.max(115, Math.min(685, this.pointer.x));
    }
  }

  renderWave() {
    const ctx = this.ctx;
    this.drawBase("Wave generator", "Change frequency to see the wave pattern");
    const frequency = Number(this.params.frequency ?? 2.4);
    const amplitude = Number(this.params.amplitude ?? 70);
    const phase = this.running ? this.time * 2.5 : 0;
    line(ctx, 70, 300, 730, 300, "#a4b7b6", 1);
    line(ctx, 400, 120, 400, 440, "#a4b7b6", 1);
    ctx.beginPath();
    for (let x = 70; x <= 730; x += 2) {
      const y = 300 - Math.sin((x / 660) * frequency * Math.PI * 2 + phase) * amplitude;
      if (x === 70) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = PALETTE.teal;
    ctx.lineWidth = 4;
    ctx.stroke();
    label(ctx, `Frequency ${frequency.toFixed(1)} Hz`, 78, 150, 14, PALETTE.ink);
    label(ctx, `Amplitude ${Math.round(amplitude)} units`, 78, 176, 14, PALETTE.ink);
  }

  terminal(ctx, id, x, y, text) {
    circle(ctx, x, y, 12, "#fffefa", PALETTE.teal);
    label(ctx, text, x - 5, y + 5, 12, PALETTE.teal, 700);
  }

  circuitTerminals() {
    return [
      { id: "positive", x: 210, y: 265, sign: "+" },
      { id: "negative", x: 210, y: 365, sign: "−" },
      { id: "lampLeft", x: 570, y: 265, sign: "A" },
      { id: "lampRight", x: 570, y: 365, sign: "B" },
    ];
  }

  isCircuitClosed() {
    const links = this.params.links || [];
    return links.some((linkItem) => linkItem.includes("positive") && linkItem.includes("lampLeft"))
      && links.some((linkItem) => linkItem.includes("negative") && linkItem.includes("lampRight"));
  }

  renderCircuit() {
    const ctx = this.ctx;
    this.drawBase("Build a complete circuit", "Select two terminals to connect a wire; close the loop to light the bulb");
    roundedRect(ctx, 105, 195, 200, 225, 20, "#e9eee4");
    roundedRect(ctx, 480, 195, 200, 225, 20, "#e9eee4");
    roundedRect(ctx, 170, 285, 80, 58, 7, "#d7b85f");
    line(ctx, 198, 285, 198, 272, PALETTE.ink, 4);
    line(ctx, 223, 285, 223, 272, PALETTE.ink, 2);
    label(ctx, "CELL", 189, 321, 12, PALETTE.ink, 700);
    const lit = this.isCircuitClosed();
    circle(ctx, 570, 315, 34, lit ? "#f4d982" : "#e6e9db", "#947b47");
    line(ctx, 552, 341, 558, 363, "#947b47", 3);
    line(ctx, 588, 341, 582, 363, "#947b47", 3);
    if (lit) {
      circle(ctx, 570, 315, 49, null, "#e6b85d");
      label(ctx, "ON", 554, 320, 12, "#715d31", 700);
    }
    const terminals = this.circuitTerminals();
    const links = this.params.links || [];
    links.forEach((linkItem) => {
      const [a, b] = linkItem.split("|");
      const first = terminals.find((item) => item.id === a);
      const second = terminals.find((item) => item.id === b);
      if (first && second) line(ctx, first.x, first.y, second.x, second.y, "#d88e57", 6);
    });
    terminals.forEach((item) => this.terminal(ctx, item.id, item.x, item.y, item.sign));
    if (this.params.pendingTerminal) {
      const first = terminals.find((item) => item.id === this.params.pendingTerminal);
      if (first) circle(ctx, first.x, first.y, 20, null, PALETTE.coral);
    }
    label(ctx, this.params.pendingTerminal ? "Choose the second terminal" : "Choose a terminal to place a wire", 282, 458, 14, PALETTE.ink);
  }

  renderTitration() {
    const ctx = this.ctx;
    this.drawBase("Acid–base titration", "Add base drop by drop and observe the pH change");
    const volume = Number(this.params.volume ?? 0);
    const ph = Math.min(13, 2 + volume * 0.11 + Math.max(0, volume - 55) * 0.13);
    roundedRect(ctx, 265, 140, 185, 38, 6, "#d8e9ec");
    line(ctx, 325, 178, 325, 330, "#99aeb0", 3);
    line(ctx, 390, 178, 390, 330, "#99aeb0", 3);
    line(ctx, 325, 330, 390, 330, "#99aeb0", 3);
    roundedRect(ctx, 328, 295 - Math.min(80, volume * 1.2), 59, 34 + Math.min(80, volume * 1.2), 3, ph < 7 ? "#e5b0ad" : "#c8dca9");
    circle(ctx, 358, 195 + (this.running ? (this.time * 45) % 78 : 20), 5, PALETTE.blue);
    roundedRect(ctx, 550, 190, 90, 155, 28, ph < 7 ? "#e7c4bf" : "#cfdfaa");
    label(ctx, `pH ${ph.toFixed(1)}`, 560, 276, 19, PALETTE.ink, 700);
    label(ctx, `${Math.round(volume)} mL added`, 537, 380, 14, PALETTE.muted);
    line(ctx, 120, 410, 710, 410, "#b0bdb8", 1);
    const px = 130 + (ph / 14) * 570;
    line(ctx, px, 400, px, 420, PALETTE.coral, 3);
    label(ctx, "Acidic", 120, 450, 12, PALETTE.muted);
    label(ctx, "Neutral", 380, 450, 12, PALETTE.muted);
    label(ctx, "Basic", 665, 450, 12, PALETTE.muted);
  }

  renderLever() {
    const ctx = this.ctx;
    this.drawBase("Lever balance", "Move the masses and find the balance point");
    const left = Number(this.params.leftMass ?? 3);
    const right = Number(this.params.rightMass ?? 3);
    const leftPosition = Number(this.params.leftPosition ?? -140);
    const rightPosition = Number(this.params.rightPosition ?? 140);
    const torqueDifference = (left * Math.abs(leftPosition)) - (right * rightPosition);
    const tilt = Math.max(-16, Math.min(16, torqueDifference / 58));
    ctx.save();
    ctx.translate(400, 315);
    ctx.rotate((tilt * Math.PI) / 180);
    line(ctx, -300, 0, 300, 0, "#967654", 12);
    circle(ctx, leftPosition, -20, 22, PALETTE.coral);
    circle(ctx, rightPosition, -20, 22, PALETTE.blue);
    label(ctx, `${left} kg`, leftPosition - 22, -53, 13, PALETTE.ink, 700);
    label(ctx, `${right} kg`, rightPosition - 22, -53, 13, PALETTE.ink, 700);
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(400, 330);
    ctx.lineTo(340, 430);
    ctx.lineTo(460, 430);
    ctx.closePath();
    ctx.fillStyle = "#c4ae83";
    ctx.fill();
    label(ctx, Math.abs(left - right) < 0.5 ? "Balanced" : left > right ? "Left side is heavier" : "Right side is heavier", 314, 465, 15, PALETTE.ink, 700);
  }

  renderPhotosynthesis() {
    const ctx = this.ctx;
    this.drawBase("Photosynthesis", "Light and carbon dioxide help plants release oxygen");
    const lightValue = Number(this.params.light ?? 65);
    const co2 = Number(this.params.co2 ?? 55);
    const rate = Math.round((lightValue * co2) / 145);
    circle(ctx, 400, 300, 68, "#8cae70");
    line(ctx, 400, 365, 400, 435, PALETTE.soil, 9);
    circle(ctx, 350, 273, 35, "#a9c98c");
    circle(ctx, 450, 273, 35, "#9fbd81");
    circle(ctx, 650, 145, 34, PALETTE.gold);
    for (let i = 0; i < rate; i += 1) {
      const x = 350 + ((i * 47 + Math.floor(this.time * 17)) % 110);
      const y = 225 - ((i * 37 + Math.floor(this.time * 22)) % 145);
      circle(ctx, x, y, 5 + (i % 3), "#d9eff0", PALETTE.blue);
    }
    roundedRect(ctx, 80, 165, 190, 105, 15, "#e8eee0");
    label(ctx, `Light ${lightValue}%`, 105, 207, 15, PALETTE.ink, 700);
    label(ctx, `CO₂ ${co2}%`, 105, 240, 15, PALETTE.ink, 700);
    label(ctx, `${rate} oxygen bubbles / cycle`, 300, 453, 15, PALETTE.teal, 700);
  }

  renderProjectile() {
    const ctx = this.ctx;
    this.drawBase("Projectile motion", "Change launch speed and angle to trace a path");
    const velocity = Number(this.params.velocity ?? 24);
    const angle = Number(this.params.angle ?? 48);
    const radians = (angle * Math.PI) / 180;
    const duration = this.running ? Math.min(this.time, 4.4) : 4.4;
    const rangeScale = 8 + velocity * 2;
    const points = [];
    for (let t = 0; t <= duration; t += 0.08) {
      const x = 95 + velocity * Math.cos(radians) * t * rangeScale / 10;
      const y = 410 - (velocity * Math.sin(radians) * t * 21 - 0.5 * 9.8 * t * t * 4.6);
      if (x > 740 || y > 410) break;
      points.push({ x, y });
    }
    line(ctx, 60, 410, 750, 410, "#8eaa8b", 3);
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.strokeStyle = PALETTE.teal;
    ctx.lineWidth = 3;
    ctx.stroke();
    const last = points[points.length - 1] || { x: 95, y: 410 };
    circle(ctx, last.x, last.y, 12, PALETTE.coral);
    label(ctx, `${velocity} m/s · ${angle}°`, 90, 150, 15, PALETTE.ink, 700);
    label(ctx, "Gravity pulls the projectile down as it travels forward.", 90, 455, 13, PALETTE.muted);
  }

  renderReaction() {
    const ctx = this.ctx;
    this.drawBase("Reaction rate", "Temperature changes how often particles collide");
    const temperature = Number(this.params.temperature ?? 25);
    const concentration = Number(this.params.concentration ?? 50);
    const speed = (temperature / 35) * (0.55 + concentration / 100);
    roundedRect(ctx, 105, 125, 590, 300, 20, "#edf0e5");
    for (let i = 0; i < 18; i += 1) {
      const x = 140 + ((i * 73 + Math.floor(this.time * 90 * speed)) % 520);
      const y = 155 + ((i * 51 + Math.floor(this.time * 57 * speed)) % 235);
      circle(ctx, x, y, i % 2 ? 10 : 8, i % 2 ? PALETTE.coral : PALETTE.blue);
    }
    label(ctx, `${temperature}°C`, 130, 465, 15, PALETTE.ink, 700);
    label(ctx, `Concentration ${concentration}%`, 540, 465, 15, PALETTE.ink, 700);
  }

  renderGenetics() {
    const ctx = this.ctx;
    this.drawBase("Punnett square", "Combine one allele from each parent to predict offspring");
    const a = this.params.parentA || "Aa";
    const b = this.params.parentB || "Aa";
    const grid = [
      [a[0], a[1]],
      [b[0], b[1]],
    ];
    roundedRect(ctx, 325, 145, 210, 210, 12, "#fffefa");
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        ctx.strokeStyle = "#aebdb2";
        ctx.lineWidth = 1;
        ctx.strokeRect(325 + col * 105, 145 + row * 105, 105, 105);
        const pair = `${grid[0][col]}${grid[1][row]}`;
        label(ctx, pair, 356 + col * 105, 208 + row * 105, 27, PALETTE.teal, 700);
      }
    }
    label(ctx, `Parent A: ${a}`, 185, 206, 16, PALETTE.ink, 700);
    label(ctx, `Parent B: ${b}`, 555, 206, 16, PALETTE.ink, 700);
    label(ctx, "Each box shows one possible allele combination.", 224, 416, 14, PALETTE.muted);
  }

  renderElectricField() {
    const ctx = this.ctx;
    this.drawBase("Electric fields", "Place charges and observe the direction of the field");
    const charges = this.params.charges || [{ x: 290, y: 285, sign: 1 }, { x: 510, y: 285, sign: -1 }];
    charges.forEach((charge) => {
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        const end = charge.sign > 0 ? angle : angle + Math.PI;
        ctx.beginPath();
        ctx.ellipse(charge.x, charge.y, 85 + i * 7, 35 + i * 4, end, -0.72, 0.72);
        ctx.strokeStyle = "#b5d1cb";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      circle(ctx, charge.x, charge.y, 22, charge.sign > 0 ? PALETTE.coral : PALETTE.blue);
      label(ctx, charge.sign > 0 ? "+" : "−", charge.x - 7, charge.y + 8, 24, "#fffefa", 700);
    });
    label(ctx, "Select the canvas to add a positive charge.", 257, 455, 14, PALETTE.muted);
  }

  destroy() {
    this.destroyed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.boundPointerDown);
    this.canvas.removeEventListener("pointermove", this.boundPointerMove);
    this.canvas.removeEventListener("pointerup", this.boundPointerUp);
    this.canvas.removeEventListener("pointercancel", this.boundPointerUp);
  }
}

function addRange(controlsEl, simulator, { name, labelText, min, max, value, step = 1, suffix = "" }) {
  const wrap = document.createElement("label");
  wrap.className = "vl-control";
  const title = document.createElement("span");
  title.className = "vl-control-label";
  title.textContent = simulator.text(`control_${name}`, labelText);
  const row = document.createElement("span");
  row.className = "vl-range-line";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", labelText);
  const output = document.createElement("output");
  output.className = "vl-control-value";
  output.textContent = `${value}${suffix}`;
  input.addEventListener("input", () => {
    output.textContent = `${input.value}${suffix}`;
    simulator.onControl(name, Number(input.value));
  });
  row.append(input, output);
  wrap.append(title, row);
  controlsEl.append(wrap);
}

function addSelect(controlsEl, simulator, { name, labelText, options, value }) {
  const wrap = document.createElement("label");
  wrap.className = "vl-control";
  const title = document.createElement("span");
  title.className = "vl-control-label";
  title.textContent = simulator.text(`control_${name}`, labelText);
  const select = document.createElement("select");
  select.setAttribute("aria-label", labelText);
  options.forEach((optionValue) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    select.append(option);
  });
  select.value = value;
  select.addEventListener("change", () => simulator.onControl(name, select.value));
  wrap.append(title, select);
  controlsEl.append(wrap);
}

const DEFAULT_CONTROLS = {
  plant_growth: [
    ["range", { name: "light", labelText: "Light", min: 0, max: 100, value: 60, suffix: "%" }],
    ["range", { name: "water", labelText: "Water", min: 0, max: 100, value: 55, suffix: "%" }],
  ],
  water_cycle: [["range", { name: "heat", labelText: "Sunlight", min: 0, max: 100, value: 65, suffix: "%" }]],
  magnet_field: [["range", { name: "magnetX", labelText: "Move magnet", min: 150, max: 650, value: 295 }]],
  wave_generator: [
    ["range", { name: "frequency", labelText: "Frequency", min: 1, max: 5, value: 2.4, step: 0.1, suffix: " Hz" }],
    ["range", { name: "amplitude", labelText: "Amplitude", min: 25, max: 110, value: 70 }],
  ],
  circuit_builder: [],
  titration: [["range", { name: "volume", labelText: "Base added", min: 0, max: 100, value: 0, suffix: " mL" }]],
  lever_balance: [
    ["range", { name: "leftMass", labelText: "Left mass", min: 1, max: 8, value: 3, suffix: " kg" }],
    ["range", { name: "rightMass", labelText: "Right mass", min: 1, max: 8, value: 3, suffix: " kg" }],
  ],
  photosynthesis_sim: [
    ["range", { name: "light", labelText: "Light intensity", min: 0, max: 100, value: 65, suffix: "%" }],
    ["range", { name: "co2", labelText: "Carbon dioxide", min: 0, max: 100, value: 55, suffix: "%" }],
  ],
  projectile: [
    ["range", { name: "velocity", labelText: "Launch speed", min: 10, max: 40, value: 24, suffix: " m/s" }],
    ["range", { name: "angle", labelText: "Launch angle", min: 15, max: 75, value: 48, suffix: "°" }],
  ],
  reaction_rate: [
    ["range", { name: "temperature", labelText: "Temperature", min: 10, max: 80, value: 25, suffix: "°C" }],
    ["range", { name: "concentration", labelText: "Concentration", min: 10, max: 100, value: 50, suffix: "%" }],
  ],
  genetics_cross: [
    ["select", { name: "parentA", labelText: "Parent A", options: ["Aa", "AA", "aa"], value: "Aa" }],
    ["select", { name: "parentB", labelText: "Parent B", options: ["Aa", "AA", "aa"], value: "Aa" }],
  ],
  electric_field: [],
};

export function createLabSimulator(canvas, controlsEl, type, options = {}) {
  const simulator = new LabSimulator(canvas, controlsEl, { ...options, type });
  (DEFAULT_CONTROLS[type] || []).forEach(([kind, control]) => {
    if (kind === "range") addRange(controlsEl, simulator, control);
    else addSelect(controlsEl, simulator, control);
  });
  if (type === "circuit_builder") {
    simulator.params.links = [];
    const terminals = simulator.circuitTerminals();
    let dragStart = null;
    let suppressClick = false;
    const findTerminal = (event) => {
      const point = simulator.localPoint(event);
      return terminals.find((item) => Math.hypot(item.x - point.x, item.y - point.y) < 23);
    };
    const connect = (firstId, secondId) => {
      if (!firstId || !secondId || firstId === secondId) return;
      const pair = [firstId, secondId].sort().join("|");
      const links = simulator.params.links || [];
      simulator.params.links = links.some((item) => item === pair)
        ? links.filter((item) => item !== pair)
        : [...links, pair];
      simulator.params.pendingTerminal = null;
      simulator.interactions += 1;
      simulator.render();
    };
    const terminalNames = {
      positive: simulator.text("terminal_positive", "Battery positive"),
      negative: simulator.text("terminal_negative", "Battery negative"),
      lampLeft: simulator.text("terminal_lamp_left", "Bulb terminal A"),
      lampRight: simulator.text("terminal_lamp_right", "Bulb terminal B"),
    };
    const makeTerminalSelect = (fieldKey, caption, initialValue) => {
      const field = document.createElement("label");
      field.className = "vl-control";
      const title = document.createElement("span");
      title.className = "vl-control-label";
      title.textContent = simulator.text(fieldKey, caption);
      const select = document.createElement("select");
      select.setAttribute("aria-label", title.textContent);
      terminals.forEach((terminal) => {
        const option = document.createElement("option");
        option.value = terminal.id;
        option.textContent = terminalNames[terminal.id];
        select.append(option);
      });
      select.value = initialValue;
      field.append(title, select);
      controlsEl.append(field);
      return select;
    };
    const firstTerminal = makeTerminalSelect("control_wire_start", "Wire start", "positive");
    const secondTerminal = makeTerminalSelect("control_wire_end", "Wire end", "lampLeft");
    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className = "vl-button vl-button-soft";
    connectButton.textContent = simulator.text("connect_wire", "Connect wire");
    connectButton.addEventListener("click", () => connect(firstTerminal.value, secondTerminal.value));
    controlsEl.append(connectButton);
    const pointerDown = (event) => {
      dragStart = findTerminal(event)?.id || null;
    };
    const pointerUp = (event) => {
      if (!dragStart) return;
      const end = findTerminal(event)?.id || null;
      if (end && end !== dragStart) {
        connect(dragStart, end);
      } else if (end) {
        if (simulator.params.pendingTerminal) connect(simulator.params.pendingTerminal, end);
        else simulator.params.pendingTerminal = end;
        simulator.render();
      }
      dragStart = null;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    };
    const clickHandler = (event) => {
      if (suppressClick) return;
      const terminal = findTerminal(event);
      if (!terminal) return;
      if (!simulator.params.pendingTerminal) simulator.params.pendingTerminal = terminal.id;
      else connect(simulator.params.pendingTerminal, terminal.id);
      simulator.render();
    };
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("click", clickHandler);
    simulator.destroy = ((originalDestroy) => function destroyCircuit() {
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("click", clickHandler);
      originalDestroy.call(this);
    })(simulator.destroy);
  }
  if (type === "electric_field") {
    const initialCharges = () => simulator.params.charges || [
      { x: 290, y: 285, sign: 1 },
      { x: 510, y: 285, sign: -1 },
    ];
    [["positive", 1, "Add positive charge"], ["negative", -1, "Add negative charge"]].forEach(([name, sign, caption]) => {
      const chargeButton = document.createElement("button");
      chargeButton.type = "button";
      chargeButton.className = "vl-button vl-button-soft";
      chargeButton.textContent = simulator.text(`add_${name}_charge`, caption);
      chargeButton.addEventListener("click", () => {
        const charges = initialCharges();
        const index = charges.length;
        simulator.params.charges = [...charges, {
          x: 170 + ((index * 119) % 460),
          y: 140 + ((index * 83) % 235),
          sign,
        }];
        simulator.interactions += 1;
        simulator.render();
      });
      controlsEl.append(chargeButton);
    });
  }
  if (type === "electric_field") {
    const previousPointerDown = simulator.boundPointerDown;
    canvas.removeEventListener("pointerdown", previousPointerDown);
    simulator.boundPointerDown = (event) => {
      const point = simulator.localPoint(event);
      const charges = simulator.params.charges || [{ x: 290, y: 285, sign: 1 }, { x: 510, y: 285, sign: -1 }];
      if (point.y > 90 && point.y < 470) {
        simulator.params.charges = [...charges, { x: point.x, y: point.y, sign: 1 }];
        simulator.interactions += 1;
        simulator.render();
      } else previousPointerDown(event);
    };
    canvas.addEventListener("pointerdown", simulator.boundPointerDown);
  }
  simulator.init();
  return simulator;
}
